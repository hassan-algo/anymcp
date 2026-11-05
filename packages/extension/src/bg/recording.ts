// Recording mode: captures a tab's API calls so they can be turned into tools.
//
// recorder.js (MAIN world) wraps fetch/XHR; relay.js (ISOLATED world) forwards captures here.
// Both are injected into the current page and also registered for the site, so recording
// continues across page loads. Captures from tabs that aren't recording are ignored.
//
// The same recorder also runs in "learn" mode while the AI works in a tab (see learn.ts). Those
// captures go to a separate buffer and never show up in the user's recording.

import type { CapturedRequest } from "@anymcp/shared";
import {
  LEARN_TABS_KEY,
  RECORDING_KEY,
  captureKey,
  learnCaptureKey,
  learnStateKey,
  type LearnTab,
  type RecordingInfo,
} from "../messages.js";
import { setRecorderActive } from "../page/inpage.js";
import { ensureAccess, hasAccess, run, webOrigin } from "./tabs.js";

const MAX_CAPTURES = 500;
const MAX_LEARN_CAPTURES = 300;
const SCRIPT_ID = "anymcp-recorder";

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function recordingTabs(): Promise<number[]> {
  const s = await chrome.storage.session.get(RECORDING_KEY);
  return (s[RECORDING_KEY] as number[] | undefined) ?? [];
}

async function learningTabs(): Promise<LearnTab[]> {
  const s = await chrome.storage.session.get(LEARN_TABS_KEY);
  return (s[LEARN_TABS_KEY] as LearnTab[] | undefined) ?? [];
}

async function setRecordingTabs(tabs: number[]): Promise<void> {
  await chrome.storage.session.set({ [RECORDING_KEY]: tabs });
  await syncRegisteredScripts();
}

/** Registers the recorder for the sites of all recording and learning tabs (or removes it). */
async function syncRegisteredScripts(): Promise<void> {
  const origins = new Set<string>();
  for (const id of await recordingTabs()) {
    const t = await chrome.tabs.get(id).catch(() => undefined);
    const o = webOrigin(t?.url);
    if (o) origins.add(`${o}/*`);
  }
  for (const l of await learningTabs()) {
    for (const o of l.origins) origins.add(`${o}/*`);
    const t = await chrome.tabs.get(l.tabId).catch(() => undefined);
    const o = webOrigin(t?.url);
    if (o && (await hasAccess(t?.url))) origins.add(`${o}/*`);
  }
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID, `${SCRIPT_ID}-relay`] }).catch(() => {});
  if (!origins.size) return;
  const matches = [...origins];
  await chrome.scripting
    .registerContentScripts([
      { id: SCRIPT_ID, js: ["page/recorder.js"], matches, runAt: "document_start", world: "MAIN", persistAcrossSessions: false },
      { id: `${SCRIPT_ID}-relay`, js: ["page/relay.js"], matches, runAt: "document_start", persistAcrossSessions: false },
    ])
    .catch(() => {});
}

export async function isRecording(tabId: number): Promise<boolean> {
  return (await recordingTabs()).includes(tabId);
}

export async function isLearning(tabId: number): Promise<boolean> {
  return (await learningTabs()).some((l) => l.tabId === tabId);
}

async function inject(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["page/relay.js"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["page/recorder.js"], world: "MAIN" });
}

export async function startRecording(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  await ensureAccess(tab.url);
  // The user's own recording wins: drop anything learned so far on this tab.
  await stopLearning(tabId, true);
  await serial(async () => {
    const tabs = await recordingTabs();
    if (!tabs.includes(tabId)) tabs.push(tabId);
    await setRecordingTabs(tabs);
  });
  await inject(tabId);
}

export async function stopRecording(tabId: number): Promise<void> {
  await serial(async () => {
    await setRecordingTabs((await recordingTabs()).filter((t) => t !== tabId));
  });
  if (!(await isLearning(tabId))) await run(tabId, setRecorderActive, [false], "MAIN").catch(() => {});
}

/** Runs the recorder on a tab in learn mode, also on `origins` (where the AI is about to go). */
export async function startLearning(tabId: number, origins: string[]): Promise<void> {
  await serial(async () => {
    const list = await learningTabs();
    const entry = list.find((l) => l.tabId === tabId);
    if (entry) entry.origins = [...new Set([...entry.origins, ...origins])];
    else list.push({ tabId, origins });
    await chrome.storage.session.set({ [LEARN_TABS_KEY]: list });
    await syncRegisteredScripts();
  });
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab && (await hasAccess(tab.url))) await inject(tabId).catch(() => {});
}

/** Stops learn mode on a tab. `discard` also throws away what it captured. */
export async function stopLearning(tabId: number, discard = false): Promise<void> {
  let was = false;
  await serial(async () => {
    const list = await learningTabs();
    was = list.some((l) => l.tabId === tabId);
    if (was) {
      await chrome.storage.session.set({ [LEARN_TABS_KEY]: list.filter((l) => l.tabId !== tabId) });
      await syncRegisteredScripts();
    }
    if (discard) await chrome.storage.session.remove([learnCaptureKey(tabId), learnStateKey(tabId)]);
  });
  if (was && !(await isRecording(tabId))) await run(tabId, setRecorderActive, [false], "MAIN").catch(() => {});
}

/** Adds a page visit to a learning tab's buffer, unless the recorder already logged it just now. */
export async function addLearnVisit(tabId: number, url: string): Promise<void> {
  await serial(async () => {
    if (!(await isLearning(tabId))) return;
    const key = learnCaptureKey(tabId);
    const s = await chrome.storage.session.get(key);
    const list = (s[key] as CapturedRequest[] | undefined) ?? [];
    const now = Date.now();
    if (list.some((c) => c.kind === "navigation" && c.url === url && now - (c.at ?? 0) < 5_000)) return;
    list.push({ kind: "navigation", method: "GET", url, status: 200, at: now });
    if (list.length > MAX_LEARN_CAPTURES) list.splice(0, list.length - MAX_LEARN_CAPTURES);
    await chrome.storage.session.set({ [key]: list });
  });
}

/** Returns and clears what learn mode captured on a tab. */
export async function takeLearnCaptures(tabId: number): Promise<CapturedRequest[]> {
  return serial(async () => {
    const key = learnCaptureKey(tabId);
    const s = await chrome.storage.session.get(key);
    await chrome.storage.session.remove(key);
    return (s[key] as CapturedRequest[] | undefined) ?? [];
  });
}

export async function getCaptures(tabId: number): Promise<CapturedRequest[]> {
  const key = captureKey(tabId);
  const s = await chrome.storage.session.get(key);
  return (s[key] as CapturedRequest[] | undefined) ?? [];
}

export async function getRecording(tabId: number): Promise<RecordingInfo> {
  return { recording: await isRecording(tabId), requests: await getCaptures(tabId) };
}

export async function clearCaptures(tabId: number): Promise<void> {
  await serial(() => chrome.storage.session.remove(captureKey(tabId)));
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

/** Captures come from the page, so check their shape before storing. */
function sanitize(raw: unknown): CapturedRequest | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return undefined;
  const method = str(r.method, 10);
  const url = str(r.url, 4_000);
  const status = typeof r.status === "number" ? r.status : NaN;
  if (!method || !url || !Number.isFinite(status)) return undefined;
  const out: CapturedRequest = {
    method,
    url,
    status,
    requestBody: str(r.requestBody, 4_000),
    requestContentType: str(r.requestContentType, 200),
    responseContentType: str(r.responseContentType, 200),
    responseSample: str(r.responseSample, 4_000),
  };
  if (r.kind === "navigation") out.kind = "navigation";
  if (Array.isArray(r.headers)) {
    const headers: NonNullable<CapturedRequest["headers"]> = [];
    for (const h of r.headers.slice(0, 50) as Record<string, unknown>[]) {
      const name = str(h?.name, 100);
      if (!name) continue;
      const ref = str(h.ref, 200);
      if (ref !== undefined && !/^(live|(cookie|meta):.{1,150})$/.test(ref)) continue;
      const value = str(h.value, 40);
      headers.push({ name, ...(ref ? { ref } : value !== undefined ? { value } : { ref: "live" }) });
    }
    if (headers.length) out.headers = headers;
  }
  if (r.refs && typeof r.refs === "object") {
    const refs: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.refs as Record<string, unknown>).slice(0, 100)) {
      if (k.length <= 200 && /^(query|body):/.test(k) && typeof v === "string" && /^(cookie|meta):.{1,150}$/.test(v)) refs[k] = v;
    }
    if (Object.keys(refs).length) out.refs = refs;
  }
  return out;
}

export async function addCapture(tabId: number, raw: unknown): Promise<void> {
  const req = sanitize(raw);
  if (!req) return;
  req.at = Date.now();
  await serial(async () => {
    if (await isRecording(tabId)) {
      const list = await getCaptures(tabId);
      list.push(req);
      if (list.length > MAX_CAPTURES) list.splice(0, list.length - MAX_CAPTURES);
      await chrome.storage.session.set({ [captureKey(tabId)]: list });
    } else if (await isLearning(tabId)) {
      const key = learnCaptureKey(tabId);
      const s = await chrome.storage.session.get(key);
      const list = (s[key] as CapturedRequest[] | undefined) ?? [];
      // A page visit may already be logged by addLearnVisit.
      if (req.kind === "navigation" && list.some((c) => c.kind === "navigation" && c.url === req.url && req.at! - (c.at ?? 0) < 5_000)) return;
      list.push(req);
      if (list.length > MAX_LEARN_CAPTURES) list.splice(0, list.length - MAX_LEARN_CAPTURES);
      await chrome.storage.session.set({ [key]: list });
    }
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    if (await isRecording(tabId)) await stopRecording(tabId).catch(() => {});
    await clearCaptures(tabId);
  })();
});

// A recording tab moved to another site: update where the recorder is registered.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  void (async () => {
    if (await isRecording(tabId)) await serial(syncRegisteredScripts);
  })();
});
