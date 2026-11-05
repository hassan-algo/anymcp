// Learning from the AI's browser work.
//
// When the AI clicks, fills or navigates on a site the user allowed, the recorder runs on that tab
// in learn mode. 8s after its last action, the API calls those actions caused (within 6s of an
// action) go to the gateway, which turns new ones into tools. Next time it's one call.

import type { CapturedRequest, GatewayMethods } from "@anymcp/shared";
import { LEARNED_PROFILE_KEY, LEARN_SETTING, learnStateKey, type LearnState } from "../messages.js";
import { addLearnVisit, isRecording, startLearning, stopLearning, takeLearnCaptures } from "./recording.js";
import { hasAccess, webOrigin } from "./tabs.js";

const FLUSH_AFTER_MS = 8_000;
const BEFORE_MS = 300;
const AFTER_MS = 6_000;

type Learn = (params: GatewayMethods["learn"]["params"]) => Promise<GatewayMethods["learn"]["result"]>;

let sendLearn: Learn | undefined;
let onLearned: ((count: number) => void) | undefined;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** The background passes in how to reach the gateway and how to show the "+N" badge. */
export function configureLearning(opts: { learn: Learn; onLearned: (count: number) => void }): void {
  sendLearn = opts.learn;
  onLearned = opts.onLearned;
}

export async function learningEnabled(): Promise<boolean> {
  const s = await chrome.storage.local.get(LEARN_SETTING);
  return s[LEARN_SETTING] !== false;
}

async function loadState(tabId: number): Promise<LearnState | undefined> {
  const key = learnStateKey(tabId);
  return ((await chrome.storage.session.get(key))[key] as LearnState | undefined) ?? undefined;
}

/**
 * Call before an AI action runs in a tab. `targetUrl` is where a navigate is going.
 * Never throws: learning must not break the action.
 */
export async function noteAiAction(tabId: number, tabUrl: string | undefined, targetUrl?: string): Promise<void> {
  try {
    if (!(await learningEnabled()) || (await isRecording(tabId))) return;
    const origins: string[] = [];
    for (const u of [tabUrl, targetUrl]) {
      const o = webOrigin(u);
      if (o && !origins.includes(o) && (await hasAccess(u))) origins.push(o);
    }
    if (!origins.length) return;
    const key = learnStateKey(tabId);
    const state: LearnState = (await loadState(tabId)) ?? { startUrl: (origins.includes(webOrigin(tabUrl) ?? "") ? tabUrl : targetUrl) ?? "", origins: [], actions: [] };
    state.origins = [...new Set([...state.origins, ...origins])];
    state.actions.push({ at: Date.now(), ...(targetUrl ? { url: targetUrl } : {}) });
    if (state.actions.length > 100) state.actions.splice(0, state.actions.length - 100);
    await chrome.storage.session.set({ [key]: state });
    await startLearning(tabId, origins);
    schedule(tabId);
  } catch {
    // ignore
  }
}

/**
 * The AI read a page (read_page, find_elements): count it as a visit to that page, so even a site
 * with no API calls gets an entry the AI can find next time.
 */
export async function noteAiVisit(tabId: number, url: string | undefined): Promise<void> {
  if (!url || !webOrigin(url)) return;
  await noteAiAction(tabId, url, url);
  try {
    await addLearnVisit(tabId, url);
  } catch {
    // ignore
  }
}

function schedule(tabId: number): void {
  clearTimeout(timers.get(tabId));
  timers.set(tabId, setTimeout(() => void flush(tabId), FLUSH_AFTER_MS));
}

/** Keeps what the AI's actions caused, not the page's own background polling. */
export function causedByActions(captures: CapturedRequest[], actions: { at: number; url?: string }[]): CapturedRequest[] {
  const out: CapturedRequest[] = [];
  for (const c of captures) {
    if (c.at === undefined) continue;
    const hits = actions.filter((a) => c.at! >= a.at - BEFORE_MS && c.at! <= a.at + AFTER_MS);
    if (!hits.length) continue;
    // A click or fill counts over a page load: the page's startup calls are mostly plumbing.
    out.push({ ...c, trigger: hits.some((a) => !a.url) ? "action" : "navigate" });
  }
  return out;
}

export async function flush(tabId: number): Promise<void> {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  const state = await loadState(tabId);
  await chrome.storage.session.remove(learnStateKey(tabId));
  const captures = await takeLearnCaptures(tabId);
  await stopLearning(tabId);
  if (!state || !(await learningEnabled())) return;
  const requests = causedByActions(captures, state.actions);
  // Page visits alone are enough: the gateway still makes an entry for the site.
  if (!requests.length || !sendLearn) return;
  try {
    const r = await sendLearn({ url: state.startUrl, requests });
    if (r.profileId) {
      let host = "";
      try {
        host = new URL(state.startUrl).host;
      } catch {
        // keep empty
      }
      // Lets an open side panel refresh its tool count for this site.
      await chrome.storage.local.set({ [LEARNED_PROFILE_KEY]: { at: Date.now(), host, profileId: r.profileId } });
    }
    if (r.added.length) onLearned?.(r.added.length);
  } catch {
    // Gateway not connected or failed: drop it silently.
  }
}

/** After a worker restart the timers are gone: flush tabs whose last action is old enough. */
export async function flushStale(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    const m = /^learnstate:(\d+)$/.exec(key);
    if (!m || timers.has(Number(m[1]))) continue;
    const last = (value as LearnState).actions?.at(-1)?.at ?? 0;
    if (Date.now() - last >= FLUSH_AFTER_MS) await flush(Number(m[1]));
  }
}

chrome.tabs.onRemoved.addListener((tabId) => void flush(tabId));

// The AI's tab moved to a site it didn't navigate to on purpose: wrap up what we have.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  void (async () => {
    const state = await loadState(tabId);
    if (!state) return;
    const o = webOrigin(info.url);
    if (!o || !state.origins.includes(o)) await flush(tabId);
  })();
});
