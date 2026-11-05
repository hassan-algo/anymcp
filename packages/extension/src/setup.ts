// "Add a site" setup window: open the site, see what's there, record how you use it, save tools.

import { isStrictSite, siteKey, type Overview, type Profile } from "@anymcp/shared";
import { webOrigin } from "./bg/tabs.js";
import { SETUP_KEY, captureKey, type RecordingInfo, type ScanResult, type SetupState } from "./messages.js";
import { $, bg, errText, gw, h, put } from "./ui/dom.js";
import { toolsFromScan } from "./scantools.js";
import { applyRecording, checkDraft, createDraft, renderDraftEditor, type Draft } from "./ui/draft.js";

type Step = "url" | "opening" | "found" | "recording" | "draft" | "done";

const state = {
  step: "url" as Step,
  input: new URLSearchParams(location.search).get("url") ?? "",
  origin: "",
  openUrl: "",
  tabId: undefined as number | undefined,
  overview: undefined as Overview | undefined,
  overviewError: "",
  official: undefined as Profile | undefined,
  pages: 0,
  calls: 0,
  draft: undefined as Draft | undefined,
  savedCount: 0,
  msg: "",
  error: "",
  busy: false,
};

const host = () => (state.origin ? new URL(state.origin).host : "");
const STEPS: Step[] = ["url", "found", "recording", "draft", "done"];

/** "instagram.com", "https://x.com/home" -> https origin and the URL to open. */
export function normalizeSite(input: string): { origin: string; url: string } | undefined {
  let s = input.trim();
  if (!s) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return undefined;
    u.protocol = "https:";
    return { origin: u.origin, url: u.href };
  } catch {
    return undefined;
  }
}

// ---- Rendering --------------------------------------------------------------

function render(): void {
  const idx = STEPS.indexOf(state.step === "opening" ? "url" : state.step);
  put($("steps"), STEPS.map((_, i) => h("span", { class: i <= idx ? "on" : "" })));
  const body = (() => {
    switch (state.step) {
      case "url":
      case "opening":
        return renderUrl();
      case "found":
        return renderFound();
      case "recording":
        return renderRecording();
      case "draft":
        return renderDraft();
      case "done":
        return renderDone();
    }
  })();
  put($("body"), ...body, state.error && h("div", { class: "notice bad", style: "margin-top:10px" }, state.error));
}

function renderUrl(): (Node | string | false | undefined)[] {
  const input = h("input", { type: "text", id: "site-url", placeholder: "e.g. instagram.com", value: state.input, "aria-label": "Website address" });
  input.addEventListener("input", () => (state.input = input.value));
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") openSite();
  });
  const opening = state.step === "opening";
  return [
    h("h2", {}, "Add a site"),
    h("p", {}, "Type the address of a website you want your AI to use."),
    h("div", { class: "row nowrap" }, input, h("button", { class: "primary", disabled: opening, onClick: openSite }, "Open site")),
    h("p", { class: "small muted" }, "Chrome asks you to allow AnyMCP on that site first."),
    opening && h("p", { class: "small" }, h("span", { class: "spinner" }), state.msg || "Opening the site…"),
  ];
}

function renderFound(): (Node | string | false | undefined)[] {
  if (state.busy) return [h("h2", {}, host()), h("p", {}, h("span", { class: "spinner" }), state.msg || "Looking at the site…")];
  const tools = (state.overview?.matching ?? []).reduce((n, p) => n + p.tools.length, 0);
  return [
    h("h2", {}, host()),
    state.overviewError && h("p", { class: "notice warn" }, "AnyMCP isn't running. You can record now; open your AI app before saving."),
    tools > 0 && h("p", { class: "muted" }, `Your AI already has ${tools} tool${tools === 1 ? "" : "s"} here. Recording adds more.`),
    isStrictSite(siteKey(host())) &&
      h(
        "p",
        { class: "notice warn" },
        `${host()} limits accounts that look automated, and its terms may not allow automated use. AnyMCP goes slowly here ` +
          "and stops if the site pushes back, but you use it at your own risk. Reading is safer than posting, liking, " +
          "following or messaging in bulk.",
      ),
    state.official &&
      h(
        "div",
        { class: "card" },
        h("p", {}, h("span", { class: "badge" }, "official"), ` ${host()} publishes its own AnyMCP tools (${state.official.tools.length}).`),
        h("button", { onClick: useOfficial }, "Use them"),
      ),
    h(
      "div",
      { class: "card" },
      h("h3", {}, `Record how you use ${host()}?`),
      h("p", { class: "desc" }, "AnyMCP turns what you do into tools for your AI."),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "primary", onClick: startRecording }, "Start recording"),
        h("button", { class: "link", onClick: () => window.close() }, "Not now"),
      ),
    ),
  ];
}

function renderRecording(): (Node | string | false | undefined)[] {
  const total = state.pages + state.calls;
  return [
    h("h2", {}, h("span", { class: "badge bad" }, "● Recording"), ` ${host()}`),
    h("p", { class: "big-count" }, `${total} item${total === 1 ? "" : "s"}`),
    h("p", { class: "small muted" }, `${state.pages} page${state.pages === 1 ? "" : "s"} · ${state.calls} API call${state.calls === 1 ? "" : "s"}`),
    h("ul", { class: "tips" }, h("li", {}, "Use the site normally in its tab."), h("li", {}, "Search, open a few items, check your messages or notifications."), h("li", {}, "A minute is usually enough.")),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", disabled: state.busy, onClick: stopRecording }, state.busy ? "Making tools…" : "Stop and make tools"),
      h("button", { class: "link", onClick: cancelRecording }, "Cancel"),
    ),
    state.msg && h("p", { class: "small" }, state.msg),
  ];
}

function renderDraft(): (Node | string | false | undefined)[] {
  const d = state.draft!;
  return [
    h("h2", {}, `New tools for ${host()}`),
    h("p", { class: "small muted" }, "Untick anything you don't want, pick a category, then save."),
    renderDraftEditor(d, {
      categories: state.overview?.categories ?? [],
      onSave: saveDraft,
      saveLabel: state.busy ? "Saving…" : "Save tools",
      onDiscard: () => {
        state.draft = undefined;
        state.step = "found";
        render();
      },
    }),
  ];
}

function renderDone(): (Node | string | false | undefined)[] {
  return [
    h("h2", {}, "Done"),
    h("p", { class: "notice" }, `${state.savedCount} tool${state.savedCount === 1 ? "" : "s"} added for ${host()}. Your AI can use them now.`),
    h("div", { class: "actions" }, h("button", { class: "primary", onClick: () => window.close() }, "Close")),
  ];
}

// ---- Steps ------------------------------------------------------------------

function openSite(): void {
  const n = normalizeSite(state.input);
  if (!n) {
    state.error = "That doesn't look like a website address. Try something like instagram.com.";
    render();
    return;
  }
  state.error = "";
  state.origin = n.origin;
  state.openUrl = n.url;
  // Ask for access straight from the click, so Chrome treats it as a user gesture.
  chrome.permissions.request({ origins: [`${n.origin}/*`] }).then(
    (granted) => {
      if (!granted) {
        state.step = "url";
        state.error = `AnyMCP needs access to ${host()} to record it. Click "Open site" again and choose Allow.`;
        render();
        return;
      }
      void afterAccess();
    },
    (e) => {
      state.error = errText(e);
      render();
    },
  );
  state.step = "opening";
  state.msg = "Waiting for you to allow access…";
  render();
}

async function normalWindowId(): Promise<number | undefined> {
  try {
    return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  } catch {
    const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return all[0]?.id;
  }
}

async function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<chrome.tabs.Tab> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete" && webOrigin(t.url)) return t;
    if (Date.now() > end) return t;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function afterAccess(): Promise<void> {
  state.msg = "Opening the site…";
  render();
  try {
    await bg({ type: "register-hooks" });
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    let tab = tabs.find((t) => webOrigin(t.url) === state.origin);
    if (tab?.id !== undefined) {
      // Reload so AnyMCP sees the page from the start (its session values and first API calls).
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.tabs.reload(tab.id);
    } else {
      const windowId = await normalWindowId();
      if (windowId !== undefined) tab = await chrome.tabs.create({ windowId, url: state.openUrl, active: true });
      else tab = (await chrome.windows.create({ url: state.openUrl, type: "normal" })).tabs?.[0];
    }
    if (tab?.id === undefined) throw new Error("Couldn't open the site.");
    state.tabId = tab.id;
    await chrome.storage.session.set({ [SETUP_KEY]: { origin: state.origin, tabId: tab.id } satisfies SetupState });
    await new Promise((r) => setTimeout(r, 300));
    state.step = "found";
    state.busy = true;
    state.msg = "Waiting for the page to load…";
    render();
    await waitForLoad(tab.id);
    await lookAround();
  } catch (e) {
    state.step = "url";
    state.error = errText(e);
    render();
  }
}

async function lookAround(): Promise<void> {
  state.busy = true;
  state.msg = "Looking at the site…";
  render();
  const url = state.openUrl || state.origin;
  const [overview, scan] = await Promise.allSettled([gw("get_overview", { url }), bg<ScanResult>({ type: "scan", tabId: state.tabId! })]);
  if (overview.status === "fulfilled") {
    state.overview = overview.value;
    state.overviewError = "";
  } else state.overviewError = errText(overview.reason);
  // Only the site's own profile is offered here; the AI's scan_site picks up forms and APIs.
  state.official = scan.status === "fulfilled" ? toolsFromScan(scan.value).official : undefined;
  state.busy = false;
  render();
}

function countCaptures(requests: { kind?: string }[]): void {
  state.pages = requests.filter((r) => r.kind === "navigation").length;
  state.calls = requests.length - state.pages;
}

async function startRecording(): Promise<void> {
  state.error = "";
  try {
    const r = await bg<RecordingInfo>({ type: "record-start", tabId: state.tabId! });
    countCaptures(r.requests);
    state.step = "recording";
    state.msg = "";
    render();
  } catch (e) {
    state.error = errText(e);
    render();
  }
}

async function cancelRecording(): Promise<void> {
  if (state.tabId !== undefined) {
    await bg({ type: "record-stop", tabId: state.tabId }).catch(() => {});
    await bg({ type: "record-clear", tabId: state.tabId }).catch(() => {});
  }
  state.step = "found";
  render();
}

async function stopRecording(): Promise<void> {
  if (state.tabId === undefined) return;
  state.busy = true;
  state.error = "";
  render();
  try {
    await bg({ type: "record-stop", tabId: state.tabId });
    const r = await bg<RecordingInfo>({ type: "record-get", tabId: state.tabId });
    const title = await chrome.tabs.get(state.tabId).then((t) => t.title).catch(() => undefined);
    const d = createDraft(state.origin, title);
    const made = applyRecording(d, r.requests);
    state.busy = false;
    if (!made) {
      // Keep recording so the user can do a bit more.
      await bg({ type: "record-start", tabId: state.tabId });
      state.msg = `Nothing in the ${r.requests.length} recorded items could become a tool yet. Keep using the site (open pages, search, open items), then stop again.`;
      render();
      return;
    }
    state.draft = d;
    state.step = "draft";
    render();
  } catch (e) {
    state.busy = false;
    state.error = errText(e);
    render();
  }
}

async function finishSaved(count: number): Promise<void> {
  state.savedCount = count;
  state.step = "done";
  if (state.tabId !== undefined) await bg({ type: "record-clear", tabId: state.tabId }).catch(() => {});
  await chrome.storage.session.remove(SETUP_KEY);
  render();
}

async function saveDraft(): Promise<void> {
  const d = state.draft;
  if (!d || state.busy) return;
  const profile = checkDraft(d);
  if (!profile) return render();
  state.busy = true;
  render();
  try {
    await gw("save_profile", { profile });
    state.busy = false;
    await finishSaved(d.tools.filter((t) => t.include).length);
  } catch (e) {
    state.busy = false;
    d.errors.push(errText(e));
    render();
  }
}

async function useOfficial(): Promise<void> {
  if (!state.official) return;
  try {
    await gw("save_profile", { profile: state.official });
    await finishSaved(state.official.tools.length);
  } catch (e) {
    state.error = errText(e);
    render();
  }
}

// ---- Live updates -------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || state.tabId === undefined) return;
  const caps = changes[captureKey(state.tabId)];
  if (caps && state.step === "recording") {
    countCaptures((caps.newValue as { kind?: string }[] | undefined) ?? []);
    render();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== state.tabId || state.step === "done") return;
  state.error = `The ${host()} tab was closed.`;
  if (state.step === "recording") state.step = "found";
  render();
});

async function init(): Promise<void> {
  // Pick up a recording in progress (e.g. this window was reloaded).
  const stored = (await chrome.storage.session.get(SETUP_KEY))[SETUP_KEY] as SetupState | undefined;
  const wanted = normalizeSite(state.input)?.origin;
  if (stored && (!wanted || wanted === stored.origin)) {
    try {
      const tab = await chrome.tabs.get(stored.tabId);
      const r = await bg<RecordingInfo>({ type: "record-get", tabId: stored.tabId });
      state.origin = stored.origin;
      state.openUrl = stored.origin;
      state.input ||= stored.origin;
      state.tabId = stored.tabId;
        if (r.recording) {
        countCaptures(r.requests);
        state.step = "recording";
        void gw("get_overview", { url: stored.origin }).then((o) => (state.overview = o), () => {});
        render();
        return;
      }
    } catch {
      await chrome.storage.session.remove(SETUP_KEY);
    }
  }
  render();
  (document.getElementById("site-url") as HTMLInputElement | null)?.focus();
}

void init();
