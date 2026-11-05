// Runs the gateway's requests (ExtensionMethods) in the browser.

import {
  browserPlaceholders,
  deriveLiveValue,
  fillBrowserPlaceholders,
  genericLivePattern,
  hostAllowed,
  LIVE_PATTERNS,
  type ExtensionMethods,
  type MethodName,
  type ResolvedHttpRequest,
} from "@anymcp/shared";
import {
  clickElement,
  collectBrowserValues,
  extractPage,
  fetchInPage,
  fillFields,
  findElements,
  hasSelector,
  readMain,
  readText,
  scrollDown,
  webmcpCall,
} from "../page/inpage.js";
import { ensureAccessOrAsk } from "./access.js";
import { requestApproval } from "./approval.js";
import { askUser } from "./ask.js";
import { noteAiAction, noteAiVisit } from "./learn.js";
import { addLearnVisit, isLearning } from "./recording.js";
import { toolsFromScan } from "../scantools.js";
import { scanTab } from "./scan.js";
import { openSetupWindow } from "./setup.js";
import {
  closeHelper,
  getTab,
  openHelper,
  run,
  settle,
  sleep,
  tabForOrigins,
  toTabInfo,
  loadedRecently,
  touchHelper,
  waitForComplete,
} from "./tabs.js";

const BODY_MAX = 2_000_000;

/**
 * Fills {$cookie:…}/{$meta:…}/{$live:…} from the tab. Live values come first from the page's own
 * latest requests; right after a page load we wait a little for its startup requests, then fall
 * back to patterns in the HTML. Values are only used for this one request, never stored.
 */
async function fillFromTab(tabId: number, request: ResolvedHttpRequest): Promise<{ request: ResolvedHttpRequest; missing: string[] }> {
  const keys = browserPlaceholders(request);
  if (!keys.length) return { request, missing: [] };
  // Values other values are derived from (jazoest comes from fb_dtsg).
  const needed = keys.includes("live:jazoest") && !keys.includes("live:fb_dtsg") ? [...keys, "live:fb_dtsg"] : keys;
  const liveNames = needed.filter((k) => k.startsWith("live:")).map((k) => k.slice(5));
  const generic = Object.fromEntries(liveNames.map((n) => [n, genericLivePattern(n)]));
  const collect = (fallbacks: boolean) => run(tabId, collectBrowserValues, [needed, fallbacks, LIVE_PATTERNS, generic], "MAIN");

  let values = await collect(false);
  const known = () => Object.fromEntries(liveNames.map((n) => [n, values[`live:${n}`]]));
  const derive = () => {
    for (const n of liveNames) {
      const key = `live:${n}`;
      if (values[key] === undefined) {
        const d = deriveLiveValue(n, known());
        if (d !== undefined) values[key] = d;
      }
    }
  };
  // Missing ones: look in the page (known patterns, hidden inputs, meta tags, cookies).
  if (keys.some((k) => values[k] === undefined)) values = { ...(await collect(true)), ...values };
  derive();
  // Still missing right after a page load: the page's startup requests may supply them soon.
  const missing = () => keys.filter((k) => k.startsWith("live:") && values[k] === undefined);
  if (missing().length && loadedRecently(tabId, 15_000)) {
    for (let waited = 0; waited < 6_000 && missing().length; waited += 500) {
      await sleep(500);
      values = { ...(await collect(false)), ...values };
      derive();
    }
  }
  return fillBrowserPlaceholders(request, values);
}

/** Waits until the page's main text stops changing (pages that render after load). */
async function waitForContent(tabId: number, selector: string | null): Promise<void> {
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const r = await run(tabId, readMain, [selector, 1]).catch(() => undefined);
    const len = r?.length ?? 0;
    if (len !== last) {
      last = len;
      stableSince = Date.now();
    } else if (len > 0 && Date.now() - stableSince >= 1_000) return;
    await sleep(250);
  }
}

type Handlers = {
  [M in MethodName]: (params: ExtensionMethods[M]["params"]) => Promise<ExtensionMethods[M]["result"]>;
};

async function accessibleTab(tabId?: number): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = await getTab(tabId);
  await ensureAccessOrAsk(tab.url);
  return tab as chrome.tabs.Tab & { id: number };
}

function targetSelector(p: { ref?: string; selector?: string }): string {
  if (p.ref) return `[data-anymcp-ref="${p.ref.replace(/["\\]/g, "")}"]`;
  if (p.selector) return p.selector;
  throw new Error("Pass a ref from find_elements, or a CSS selector.");
}

function checkHost(url: string, allowedHosts: string[]): void {
  if (!hostAllowed(url, allowedHosts)) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep url
    }
    throw new Error(`Blocked: ${host} is not one of this profile's allowed hosts (${allowedHosts.join(", ")}).`);
  }
}

/** Closes a helper tab, first giving the page's last captured requests a moment to arrive. */
async function closeLearningHelper(tabId: number): Promise<void> {
  await sleep(400);
  await closeHelper(tabId);
}

export const handlers: Handlers = {
  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => t.id !== undefined).map(toTabInfo);
  },

  async read_page({ tabId, maxChars = 50_000 }) {
    const tab = await accessibleTab(tabId);
    await noteAiVisit(tab.id, tab.url);
    const page = await run(tab.id, extractPage, [maxChars]);
    return { tabId: tab.id, ...page };
  },

  async find_elements({ tabId, query, limit = 100 }) {
    const tab = await accessibleTab(tabId);
    await noteAiVisit(tab.id, tab.url);
    const r = await run(tab.id, findElements, [query ?? null, Math.max(1, Math.min(limit, 500))]);
    return { tabId: tab.id, ...r };
  },

  async click(p) {
    const tab = await accessibleTab(p.tabId);
    await noteAiAction(tab.id, tab.url);
    const r = await run(tab.id, clickElement, [targetSelector(p)]);
    const after = await settle(tab.id);
    return { tabId: tab.id, url: after.url ?? "", title: after.title ?? "", note: `Clicked "${r.clicked}".` };
  },

  async fill(p) {
    const tab = await accessibleTab(p.tabId);
    await noteAiAction(tab.id, tab.url);
    await run(tab.id, fillFields, [null, [[targetSelector(p), String(p.value)]], null, Boolean(p.submit)]);
    const after = await settle(tab.id);
    return { tabId: tab.id, url: after.url ?? "", title: after.title ?? "", note: p.submit ? "Filled and submitted." : "Filled." };
  },

  async navigate({ url, tabId, newTab }) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`"${url}" is not a valid URL.`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs can be opened.");
    let tab: chrome.tabs.Tab;
    const current = newTab ? undefined : await getTab(tabId).catch(() => undefined);
    if (current?.id !== undefined) {
      // Start learning first, so the recorder is ready when the new page loads.
      await noteAiAction(current.id, current.url, u.href);
      tab = (await chrome.tabs.update(current.id, { url: u.href })) ?? current;
    } else {
      tab = await chrome.tabs.create({ url: "about:blank", active: true });
      await noteAiAction(tab.id!, undefined, u.href);
      tab = (await chrome.tabs.update(tab.id!, { url: u.href })) ?? tab;
    }
    await sleep(100);
    const done = await waitForComplete(tab.id!, 30_000);
    // In case the recorder missed the first load, log the visit (no-op unless learning).
    if (done.url) await addLearnVisit(done.id!, done.url).catch(() => {});
    return toTabInfo(done);
  },

  async screenshot({ tabId }) {
    const tab = await accessibleTab(tabId);
    if (!(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) {
      throw new Error('Chrome only allows screenshots when AnyMCP has "Allow on all sites" access. Turn it on in the AnyMCP side panel.');
    }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await sleep(150);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { tabId: tab.id, mimeType: "image/png", data: dataUrl.replace(/^data:image\/png;base64,/, "") };
  },

  async run_http({ origins, allowedHosts, request }) {
    checkHost(request.url, allowedHosts);
    if (!origins.length) throw new Error("This profile lists no origins to run from.");
    await ensureAccessOrAsk(origins[0]!);
    const tab = await tabForOrigins(origins, origins[0]!);
    const filled = await fillFromTab(tab.id!, request);
    checkHost(filled.request.url, allowedHosts);
    const res = await run(tab.id!, fetchInPage, [filled.request, BODY_MAX]);
    await touchHelper(tab.id!);
    checkHost(res.url || filled.request.url, allowedHosts);
    return filled.missing.length ? { ...res, missing: filled.missing } : res;
  },

  async run_page({ allowedHosts, action }) {
    checkHost(action.url, allowedHosts);
    await ensureAccessOrAsk(action.url);
    // Learn from the site's own data calls while it loads (closing the tab sends them).
    const tab = await openHelper(action.url, (id) => noteAiAction(id, undefined, action.url));
    const tabId = tab.id!;
    if (tab.url) await addLearnVisit(tabId, tab.url).catch(() => {});
    try {
      const after = await chrome.tabs.get(tabId);
      if (after.url) checkHost(after.url, allowedHosts);
      if (action.waitFor) {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !(await run(tabId, hasSelector, [action.waitFor]).catch(() => false))) await sleep(300);
      } else {
        await waitForContent(tabId, action.read ?? null);
      }
      const page = await run(tabId, readMain, [action.read ?? null, action.maxChars]);
      // While learning, scroll a bit: many sites fetch their lists ("load more") through an API
      // only then, and that call becomes a cheap tool for next time.
      if (await isLearning(tabId)) {
        await noteAiAction(tabId, page.url, page.url);
        for (let i = 0; i < 3; i++) {
          if (!(await run(tabId, scrollDown, []).catch(() => false))) break;
          await sleep(900);
        }
      }
      const final = await chrome.tabs.get(tabId);
      if (final.url) checkHost(final.url, allowedHosts);
      return { tabId, title: page.title, url: page.url, text: page.text, truncated: page.truncated, htmlChars: page.htmlChars };
    } finally {
      await closeLearningHelper(tabId);
    }
  },

  async run_form({ allowedHosts, action }) {
    checkHost(action.page, allowedHosts);
    await ensureAccessOrAsk(action.page);
    const tab = await openHelper(action.page, (id) => noteAiAction(id, undefined, action.page));
    const tabId = tab.id!;
    try {
      const startUrl = tab.url ?? "";
      await run(tabId, fillFields, [action.form, Object.entries(action.fields), action.submit ?? null, true]);

      // Wait for the result: a navigation, or the waitFor element.
      await sleep(800);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "loading") await waitForComplete(tabId, Math.max(1_000, deadline - Date.now())).catch(() => {});
        const ready = action.waitFor
          ? await run(tabId, hasSelector, [action.waitFor]).catch(() => false)
          : (await chrome.tabs.get(tabId)).status === "complete";
        if (ready || Date.now() > deadline) break;
        await sleep(500);
      }
      const after = await chrome.tabs.get(tabId);
      if (after.url && after.url !== startUrl) checkHost(after.url, allowedHosts);
      const page = await run(tabId, readText, [action.read ?? null, action.maxChars]);
      return { tabId, ...page };
    } finally {
      await closeLearningHelper(tabId);
    }
  },

  async run_webmcp({ allowedHosts, page, tool, args }) {
    checkHost(page, allowedHosts);
    const origin = new URL(page).origin;
    await ensureAccessOrAsk(origin);
    const tab = await tabForOrigins([origin], page);
    const r = await run(tab.id!, webmcpCall, [tool, args ?? {}, 5_000], "MAIN");
    await touchHelper(tab.id!);
    return r;
  },

  async request_approval(params) {
    return requestApproval(params);
  },

  async ask_user(params) {
    return askUser(params);
  },

  async scan_tab({ tabId }) {
    const tab = await accessibleTab(tabId);
    await waitForComplete(tab.id, 15_000).catch(() => undefined);
    const s = toolsFromScan(await scanTab(tab.id));
    return {
      url: tab.url ?? "",
      tools: s.items.map((i) => i.tool),
      allowedHosts: s.allowedHosts,
      notes: s.notes,
      ...(s.officialRaw !== undefined ? { official: s.officialRaw } : {}),
    };
  },

  async open_setup({ url }) {
    await openSetupWindow(url);
    return { opened: true as const };
  },
};
