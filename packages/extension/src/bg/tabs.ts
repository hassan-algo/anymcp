// Tab helpers: site access checks, running injected functions, and background "helper" tabs.

import { originMatches, type TabInfo } from "@anymcp/shared";
import type { InjectedError } from "../page/inpage.js";

const HELPERS_KEY = "helperTabs";
const HELPER_IDLE_MS = 5 * 60_000;

export function toTabInfo(t: chrome.tabs.Tab): TabInfo {
  return { id: t.id!, windowId: t.windowId, title: t.title ?? "", url: t.url ?? "", active: t.active };
}

export async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return tab;
}

export async function getTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId === undefined) return activeTab();
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`There's no tab with id ${tabId}. Call list_tabs to see open tabs.`);
  }
}

export function webOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export function noAccessMessage(host: string): string {
  return `AnyMCP isn't allowed on ${host} yet. Open the AnyMCP side panel on that site and click "Allow on this site".`;
}

export async function hasAccess(url: string | undefined): Promise<boolean> {
  const origin = webOrigin(url);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

/** Throws a helpful error unless the user allowed AnyMCP on this page's site. */
export async function ensureAccess(url: string | undefined): Promise<void> {
  const origin = webOrigin(url);
  if (!origin) throw new Error(`AnyMCP can't run on ${url || "this page"}. Only regular http(s) web pages work.`);
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    throw new Error(noAccessMessage(new URL(origin).host));
  }
}

/** Runs a self-contained function in a tab and returns its result. */
export async function run<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
  world: "ISOLATED" | "MAIN" = "ISOLATED",
): Promise<Exclude<Awaited<R>, InjectedError>> {
  let results: chrome.scripting.InjectionResult<unknown>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: func as unknown as () => R,
      args: args as never,
      world,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/Cannot access|permission|host/i.test(msg)) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      const origin = webOrigin(tab?.url);
      if (origin) throw new Error(noAccessMessage(new URL(origin).host));
    }
    throw new Error(`Couldn't run in the tab: ${msg}`);
  }
  const result = results[0]?.result as unknown;
  if (result && typeof result === "object" && "__error" in (result as object)) {
    throw new Error((result as InjectedError).__error);
  }
  return result as Exclude<Awaited<R>, InjectedError>;
}

/** Resolves when the tab finishes loading. */
export function waitForComplete(tabId: number, timeoutMs = 30_000): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      fn();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === "complete") finish(() => resolve(tab));
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(() => reject(new Error("The tab was closed.")));
    };
    const timer = setTimeout(() => {
      finish(() => chrome.tabs.get(tabId).then(resolve, () => reject(new Error("The tab was closed."))));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then(
      (t) => {
        if (t.status === "complete") finish(() => resolve(t));
      },
      () => finish(() => reject(new Error("The tab was closed."))),
    );
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// When each tab last finished loading (this worker's lifetime only).
const loadedAt = new Map<number, number>();
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "complete") loadedAt.set(id, Date.now());
});
chrome.tabs.onRemoved.addListener((id) => loadedAt.delete(id));

/** True if the tab finished loading less than `ms` ago. */
export function loadedRecently(tabId: number, ms: number): boolean {
  const t = loadedAt.get(tabId);
  return t !== undefined && Date.now() - t < ms;
}

/** After a click or submit: give the page a moment, and wait for a navigation if one started. */
export async function settle(tabId: number): Promise<chrome.tabs.Tab> {
  await sleep(400);
  const t = await chrome.tabs.get(tabId);
  if (t.status === "loading") return waitForComplete(tabId, 3_000);
  return t;
}

// ---- Helper tabs ------------------------------------------------------------

interface Helper {
  tabId: number;
  lastUsed: number;
}

async function getHelpers(): Promise<Record<string, Helper>> {
  const s = await chrome.storage.session.get(HELPERS_KEY);
  return (s[HELPERS_KEY] as Record<string, Helper> | undefined) ?? {};
}

async function setHelpers(h: Record<string, Helper>): Promise<void> {
  await chrome.storage.session.set({ [HELPERS_KEY]: h });
}

export async function isHelperTab(tabId: number): Promise<boolean> {
  return Object.values(await getHelpers()).some((h) => h.tabId === tabId);
}

/**
 * A tab on one of `origins` to run requests from: an open tab the user already has (active one
 * first), or a background tab AnyMCP opens at `openUrl` and closes after a few idle minutes.
 */
export async function tabForOrigins(origins: string[], openUrl: string): Promise<chrome.tabs.Tab> {
  const helpers = await getHelpers();
  const helperIds = new Set(Object.values(helpers).map((h) => h.tabId));
  const tabs = (await chrome.tabs.query({})).filter(
    (t) => t.id !== undefined && !t.discarded && t.url && originMatches(origins, t.url),
  );
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || Number(helperIds.has(a.id!)) - Number(helperIds.has(b.id!)));
  for (const t of tabs) {
    if (await hasAccess(t.url)) {
      if (helperIds.has(t.id!)) await touchHelper(t.id!);
      if (t.status !== "complete") return waitForComplete(t.id!, 15_000);
      return t;
    }
  }
  return openHelper(openUrl);
}

/**
 * Opens a background tab at `url` and waits for it to load. `beforeLoad` runs on the blank tab
 * first (e.g. to start learning, so the recorder sees the page's first requests).
 */
export async function openHelper(url: string, beforeLoad?: (tabId: number) => Promise<void>): Promise<chrome.tabs.Tab> {
  await ensureAccess(url);
  const tab = await chrome.tabs.create({ url: beforeLoad ? "about:blank" : url, active: false });
  const helpers = await getHelpers();
  helpers[`${tab.id}`] = { tabId: tab.id!, lastUsed: Date.now() };
  await setHelpers(helpers);
  if (beforeLoad) {
    await beforeLoad(tab.id!).catch(() => {});
    await chrome.tabs.update(tab.id!, { url });
    await new Promise((r) => setTimeout(r, 100));
  }
  return waitForComplete(tab.id!, 20_000);
}

export async function touchHelper(tabId: number): Promise<void> {
  const helpers = await getHelpers();
  const h = helpers[`${tabId}`];
  if (h) {
    h.lastUsed = Date.now();
    await setHelpers(helpers);
  }
}

export async function closeHelper(tabId: number): Promise<void> {
  const helpers = await getHelpers();
  delete helpers[`${tabId}`];
  await setHelpers(helpers);
  await chrome.tabs.remove(tabId).catch(() => {});
}

/** Closes helper tabs nobody has used for a while. */
export async function cleanupHelperTabs(): Promise<void> {
  const helpers = await getHelpers();
  let changed = false;
  for (const [key, h] of Object.entries(helpers)) {
    const exists = await chrome.tabs.get(h.tabId).then(
      () => true,
      () => false,
    );
    if (!exists || Date.now() - h.lastUsed > HELPER_IDLE_MS) {
      if (exists) await chrome.tabs.remove(h.tabId).catch(() => {});
      delete helpers[key];
      changed = true;
    }
  }
  if (changed) await setHelpers(helpers);
}
