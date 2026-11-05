// Asking for site access when the AI needs a site AnyMCP isn't allowed on yet.
// A small window asks the user; Chrome only grants access from a click, so the window's button
// makes the request. "Not now" is remembered for 10 minutes so the AI can't keep asking.

import { noAccessMessage, webOrigin } from "./tabs.js";

const ANSWER_TIMEOUT_MS = 120_000;
const NOT_NOW_MS = 10 * 60_000;
/** Test builds only: origins to treat as not yet allowed (lets tests drive the window). */
export const TEST_DENY_KEY = "__testDenyOrigins";

interface Pending {
  origin: string;
  promise: Promise<boolean>;
  resolve: (granted: boolean) => void;
  windowId?: number;
  timer: ReturnType<typeof setTimeout>;
}

const pendingById = new Map<string, Pending>();
const pendingByOrigin = new Map<string, Pending>();
const notNowUntil = new Map<string, number>();

async function testDenied(origin: string): Promise<string[] | undefined> {
  const s = await chrome.storage.local.get(TEST_DENY_KEY);
  const list = s[TEST_DENY_KEY] as string[] | undefined;
  return Array.isArray(list) && list.includes(origin) ? list : undefined;
}

export async function originAllowed(origin: string): Promise<boolean> {
  if (await testDenied(origin)) return false;
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

function finish(id: string, granted: boolean): void {
  const p = pendingById.get(id);
  if (!p) return;
  pendingById.delete(id);
  pendingByOrigin.delete(p.origin);
  clearTimeout(p.timer);
  if (!granted) notNowUntil.set(p.origin, Date.now() + NOT_NOW_MS);
  if (p.windowId !== undefined) chrome.windows.remove(p.windowId).catch(() => {});
  p.resolve(granted);
}

/** Opens the allow window (one per site at a time) and resolves with the user's answer. */
function askUser(origin: string): Promise<boolean> {
  const existing = pendingByOrigin.get(origin);
  if (existing) return existing.promise;
  const id = crypto.randomUUID();
  let resolve!: (granted: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  const entry: Pending = { origin, promise, resolve, timer: setTimeout(() => finish(id, false), ANSWER_TIMEOUT_MS) };
  pendingById.set(id, entry);
  pendingByOrigin.set(origin, entry);
  const url = chrome.runtime.getURL(`allow.html?id=${id}&origin=${encodeURIComponent(origin)}`);
  chrome.windows
    .create({ url, type: "popup", width: 420, height: 360, focused: true })
    .then((win) => {
      if (!pendingById.has(id)) {
        if (win?.id !== undefined) chrome.windows.remove(win.id).catch(() => {});
        return;
      }
      entry.windowId = win?.id;
    })
    .catch(() => finish(id, false));
  return promise;
}

/**
 * For AI calls: makes sure AnyMCP may run on the page's site, asking the user if needed.
 * Throws the usual "isn't allowed" error if they say no (or said no in the last 10 minutes).
 */
export async function ensureAccessOrAsk(url: string | undefined): Promise<void> {
  const origin = webOrigin(url);
  if (!origin) throw new Error(`AnyMCP can't run on ${url || "this page"}. Only regular http(s) web pages work.`);
  if (await originAllowed(origin)) return;
  const host = new URL(origin).host;
  if ((notNowUntil.get(origin) ?? 0) > Date.now()) throw new Error(noAccessMessage(host));
  if (!(await askUser(origin))) throw new Error(noAccessMessage(host));
  await onGranted?.();
}

let onGranted: (() => Promise<void>) | undefined;

/** The background passes in what to do after access is granted (register the page hooks). */
export function configureAccess(opts: { onGranted: () => Promise<void> }): void {
  onGranted = opts.onGranted;
}

/** For allow.html: what's being asked. */
export function getAllowRequest(id: string): { origin: string } | null {
  const p = pendingById.get(id);
  return p ? { origin: p.origin } : null;
}

/** From allow.html, after it called chrome.permissions.request (or the user said "Not now"). */
export async function answerAllow(id: string, granted: boolean): Promise<void> {
  const p = pendingById.get(id);
  if (!p) return;
  if (granted) {
    const list = await testDenied(p.origin);
    if (list) await chrome.storage.local.set({ [TEST_DENY_KEY]: list.filter((o) => o !== p.origin) });
    granted = await originAllowed(p.origin);
  }
  finish(id, granted);
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, p] of pendingById) {
    if (p.windowId === windowId) finish(id, false);
  }
});
