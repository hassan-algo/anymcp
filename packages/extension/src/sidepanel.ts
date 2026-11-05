// Side panel: connection status, token savings, this site's tools, your sites, and settings.
// Managing tools (adding sites, removing tools, sharing) the AI does through AnyMCP's tools.

import { DEFAULT_PORT, type Overview, type UsageStats } from "@anymcp/shared";
import { TEST_DENY_KEY, originAllowed } from "./bg/access.js";
import { webOrigin } from "./bg/tabs.js";
import { LEARNED_PROFILE_KEY, LEARN_SETTING, STATUS_KEY, type ConnectionStatus, type StatusInfo } from "./messages.js";
import { $, bg, errText, gw, h, put } from "./ui/dom.js";

const state = {
  status: { status: "disconnected" } as StatusInfo,
  tab: undefined as chrome.tabs.Tab | undefined,
  origin: undefined as string | undefined,
  allowed: false,
  overview: undefined as Overview | undefined,
  stats: undefined as UsageStats | undefined,
  savingsOpen: false,
  sitesOpen: false,
  error: "",
  learn: true,
  settingsMsg: "",
};

const connected = () => state.status.status === "connected";
const host = () => (state.origin ? new URL(state.origin).host.replace(/^www\./, "") : "");

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Waiting for your AI app",
  "auth-failed": "Pairing failed",
};

// ---- Status -----------------------------------------------------------------

function renderStatus(): void {
  const s = state.status.status;
  $("dot").className = `dot ${s}`;
  $("status-text").textContent = STATUS_LABELS[s];
  const note = $("status-note");
  const text =
    s === "disconnected"
      ? "AnyMCP starts when an AI app that uses it is open."
      : s === "auth-failed"
        ? "AnyMCP didn't recognise this browser. Enter the pairing token under Settings → Advanced."
        : "";
  note.hidden = !text;
  note.textContent = text;
  note.className = s === "auth-failed" ? "note bad" : "note";
  // Savings and sites come from the gateway: hide them as soon as it's gone.
  if (s !== "connected") {
    $("savings").hidden = true;
    $("sites").hidden = true;
  }
}

// ---- This site ----------------------------------------------------------------

async function refreshSite(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  state.origin = webOrigin(tab?.url);
  state.allowed = state.origin ? await originAllowed(state.origin) : false;
  state.error = "";
  state.overview = undefined;
  if (connected()) {
    try {
      // Without a usable site, still load the overview for "Your sites".
      state.overview = await gw("get_overview", state.origin && state.allowed ? { url: tab?.url } : {});
    } catch (e) {
      state.error = errText(e);
    }
  }
  renderSite();
  renderSites();
  await refreshStats();
}

// ---- Savings ------------------------------------------------------------------

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function refreshStats(): Promise<void> {
  if (!connected()) {
    state.stats = undefined;
  } else {
    try {
      state.stats = await gw("get_stats", {});
    } catch {
      state.stats = undefined; // older gateway without stats
    }
  }
  renderSavings();
  renderSites();
}

function renderSavings(): void {
  const el = $("savings");
  const st = state.stats;
  el.hidden = !connected() || !st;
  if (!st) return;
  const pages = st.pages ?? { calls: 0, htmlTokens: 0, textTokens: 0 };
  if (!st.calls && !pages.calls) {
    put(el, h("p", { class: "savings-empty muted" }, "No savings yet"));
    return;
  }
  const sub = [
    st.calls && plural(st.calls, "API call"),
    pages.calls && plural(pages.calls, "page read"),
    st.toolList.toolCount && `${fmt(st.toolList.loadedTokens)}-token tool list instead of ${fmt(st.toolList.allToolsTokens)}`,
  ].filter(Boolean);
  const head = h(
    "summary",
    {},
    h(
      "span",
      { class: "savings-main" },
      // Older gateways only report API savings.
      st.totalSavedTokens !== undefined
        ? `Saved ≈ ${fmt(st.totalSavedTokens)} tokens (${st.totalPercent}%)`
        : `Saved ≈ ${fmt(st.savedTokens)} tokens (${st.savedPercent}%)`,
    ),
    h("span", { class: "savings-sub muted small" }, sub.join(" · ")),
  );
  const rows = st.sites
    .filter((s) => s.calls || s.pageCalls)
    .slice(0, 8)
    .map((s) =>
      h(
        "li",
        {},
        h("span", { class: "site-name" }, s.id),
        h(
          "span",
          { class: "muted small" },
          [
            s.calls ? `${fmt(s.savedTokens)} saved` : "",
            s.pageCalls ? `${plural(s.pageCalls, "page read")} (${fmt(s.pageHtmlTokens)} HTML → ${fmt(s.pageTextTokens)} text)` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
    );
  const details = h(
    "details",
    { class: "savings card", open: state.savingsOpen },
    head,
    h("ul", { class: "rows" }, rows),
    st.toolList.toolCount > 0 &&
      h(
        "p",
        { class: "small" },
        `Tool list: ${fmt(st.toolList.loadedTokens)} tokens in your AI's context instead of ${fmt(st.toolList.allToolsTokens)} for all ${st.toolList.toolCount} site tools.`,
      ),
    h(
      "p",
      { class: "muted small" },
      "API savings: what sites sent vs what your AI got. Page reads are shown separately: they save versus raw HTML, not versus reading the page yourself. ≈4 characters per token.",
    ),
  );
  details.addEventListener("toggle", () => (state.savingsOpen = details.open));
  put(el, details);
}

// ---- Your sites ---------------------------------------------------------------

function renderSites(): void {
  const el = $("sites");
  const local = state.overview?.local ?? [];
  el.hidden = !connected() || !local.length;
  if (el.hidden) return;
  // API savings plus page reads (HTML the AI didn't have to take in).
  const saved = new Map((state.stats?.sites ?? []).map((s) => [s.id, s.savedTokens + Math.max(0, (s.pageHtmlTokens ?? 0) - (s.pageTextTokens ?? 0))]));
  const sorted = [...local].sort((a, b) => (saved.get(b.id) ?? 0) - (saved.get(a.id) ?? 0) || b.tools.length - a.tools.length);
  const details = h(
    "details",
    { class: "sites", open: state.sitesOpen },
    h("summary", {}, `Your sites (${local.length})`),
    h(
      "ul",
      { class: "rows" },
      sorted.map((p) => {
        const origin = p.origins[0];
        const tokens = saved.get(p.id) ?? 0;
        return h(
          "li",
          {},
          h("span", { class: "site-name" }, p.id),
          h("span", { class: "muted small" }, [plural(p.tools.length, "tool"), tokens ? `${fmt(tokens)} saved` : ""].filter(Boolean).join(" · ")),
          origin && h("button", { class: "link", title: origin, onClick: () => void chrome.tabs.create({ url: origin }) }, "Open"),
        );
      }),
    ),
  );
  details.addEventListener("toggle", () => (state.sitesOpen = details.open));
  put(el, details);
}

function allowSite(): void {
  const origin = state.origin;
  if (!origin) return;
  // Straight from the click: Chrome only grants access in response to a user gesture.
  void chrome.permissions.request({ origins: [`${origin}/*`] }).then(async () => {
    // Test builds mark sites as not allowed with a storage flag.
    const s = await chrome.storage.local.get(TEST_DENY_KEY);
    const list = s[TEST_DENY_KEY];
    if (Array.isArray(list)) await chrome.storage.local.set({ [TEST_DENY_KEY]: list.filter((o) => o !== origin) });
    await bg({ type: "register-hooks" }).catch(() => {});
    await refreshSite();
  }, refreshSite);
}

function recordSite(): void {
  void bg({ type: "open-setup", url: state.tab?.url ?? state.origin }).catch((e) => {
    state.error = errText(e);
    renderSite();
  });
}

function renderSite(): void {
  const el = $("site");
  if (!state.origin) {
    put(el, h("p", { class: "muted" }, "Open a website to see what your AI can do there."));
    return;
  }
  const title = h("h2", {}, host());
  if (!state.allowed) {
    put(
      el,
      title,
      h("p", { class: "muted" }, "AnyMCP can't use this site yet."),
      h("button", { class: "primary", onClick: allowSite }, "Allow on this site"),
    );
    return;
  }

  const tools = (state.overview?.matching ?? []).flatMap((p) => p.tools);
  const record = h("button", { onClick: recordSite }, "Record this site");
  let body: (Node | string | false)[];
  if (!connected()) {
    body = [h("p", { class: "muted" }, "Tools show here while AnyMCP is running.")];
  } else if (state.error) {
    body = [h("p", { class: "note bad" }, state.error)];
  } else if (!tools.length) {
    body = [h("p", { class: "muted" }, "No tools yet. Your AI will learn this site as it uses it, or record it yourself.")];
  } else {
    body = [
      h(
        "details",
        { class: "tools" },
        h("summary", {}, h("strong", {}, String(tools.length)), ` tool${tools.length === 1 ? "" : "s"} for your AI`),
        h(
          "ul",
          {},
          tools.map((t) => h("li", { title: t.description }, h("span", {}, t.title), t.mutates && h("span", { class: "tag" }, "changes data"))),
        ),
      ),
    ];
  }
  put(el, title, ...body, h("div", { class: "actions" }, record));
}

// ---- Settings ---------------------------------------------------------------

function renderSettings(): void {
  const s = state.status.status;
  const learn = h("input", { type: "checkbox", checked: state.learn });
  learn.addEventListener("change", () => {
    state.learn = learn.checked;
    void chrome.storage.local.set({ [LEARN_SETTING]: learn.checked });
  });

  const port = h("input", { type: "number", min: "1", max: "65535", "aria-label": "Port" });
  const token = h("input", { type: "password", autocomplete: "off", placeholder: "Only for other browsers or builds", "aria-label": "Pairing token" });
  const repo = h("input", { type: "text", placeholder: "owner/repo", value: state.overview?.registryRepo ?? "", "aria-label": "Registry repo" });
  const regUrl = h("input", { type: "text", placeholder: "Default", "aria-label": "Registry URL" });
  let regUrlDirty = false;
  regUrl.addEventListener("input", () => (regUrlDirty = true));
  void chrome.storage.local.get(["token", "port"]).then((v) => {
    token.value = typeof v.token === "string" ? v.token : "";
    port.value = String(typeof v.port === "number" ? v.port : DEFAULT_PORT);
  });

  const msg = (text: string) => {
    state.settingsMsg = text;
    renderSettings();
  };
  const saveConnection = async () => {
    await chrome.storage.local.set({ token: token.value.trim(), port: Number(port.value) || DEFAULT_PORT });
    await bg({ type: "settings-changed" });
    msg("Saved. Reconnecting…");
  };
  const saveRegistry = async () => {
    try {
      await gw("set_settings", { registryRepo: repo.value.trim(), ...(regUrlDirty ? { registryUrl: regUrl.value.trim() } : {}) });
      msg("Saved.");
    } catch (e) {
      msg(errText(e));
    }
  };
  const sync = async () => {
    msg("Syncing…");
    try {
      const r = await gw("sync_registry", {});
      msg(`Registry updated: ${r.profiles} profiles.`);
      await refreshSite();
    } catch (e) {
      msg(errText(e));
    }
  };

  const field = (label: string, input: HTMLElement) => h("label", { class: "field" }, h("span", {}, label), input);
  put(
    $("settings"),
    h(
      "details",
      { open: s === "auth-failed" },
      h("summary", {}, "Settings"),
      h("label", { class: "check" }, learn, "Learn from your AI's browser work"),
      h(
        "details",
        { class: "advanced", open: s === "auth-failed" },
        h("summary", {}, "Advanced"),
        field("Port", port),
        field("Pairing token", token),
        h("div", { class: "actions" }, h("button", { onClick: saveConnection }, "Save and reconnect")),
        field("Registry repo", repo),
        field("Registry URL", regUrl),
        h(
          "div",
          { class: "actions" },
          h("button", { disabled: !connected(), onClick: saveRegistry }, "Save"),
          h("button", { disabled: !connected(), onClick: sync }, "Sync registry now"),
        ),
        state.status.gatewayVersion && h("p", { class: "muted small" }, `AnyMCP ${state.status.gatewayVersion}`),
      ),
      state.settingsMsg && h("p", { class: "muted small" }, state.settingsMsg),
    ),
  );
}

// ---- Wiring -----------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
function refreshSoon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refreshSite(), 250);
}

chrome.tabs.onActivated.addListener(refreshSoon);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tab?.id && (info.url || info.status === "complete")) refreshSoon();
});
chrome.windows.onFocusChanged.addListener(refreshSoon);
chrome.permissions.onAdded.addListener(refreshSoon);
chrome.permissions.onRemoved.addListener(refreshSoon);

chrome.storage.onChanged.addListener((changes, area) => {
  // The AI's work made or updated this site's entry.
  if (area === "local" && changes[LEARNED_PROFILE_KEY]) {
    const v = changes[LEARNED_PROFILE_KEY].newValue as { host?: string } | undefined;
    if (v?.host && v.host.replace(/^www\./, "") === host()) refreshSoon();
  }
  if (area === "local" && changes[TEST_DENY_KEY]) refreshSoon();
  const status = area === "session" ? (changes[STATUS_KEY]?.newValue as StatusInfo | undefined) : undefined;
  if (status) {
    const was = state.status.status;
    state.status = status;
    renderStatus();
    if (was !== status.status) {
      renderSettings();
      refreshSoon();
    }
  }
});

// Savings refresh while the panel is visible.
setInterval(() => {
  if (document.visibilityState === "visible") void refreshStats();
}, 30_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshStats();
});

async function init(): Promise<void> {
  try {
    state.status = await bg<StatusInfo>({ type: "status" });
  } catch {
    // background still starting
  }
  state.learn = (await chrome.storage.local.get(LEARN_SETTING))[LEARN_SETTING] !== false;
  renderStatus();
  renderSettings();
  await refreshSite();
  renderSettings(); // fills the registry repo once the overview is loaded
}

void init();
