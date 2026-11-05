// Service worker: keeps a WebSocket open to the local AnyMCP gateway, runs its requests in tabs,
// and passes requests from the extension's pages to the gateway.

import {
  CLOSE_AUTH_FAILED,
  CLOSE_HANDOVER,
  DEFAULT_PORT,
  type ClientToGateway,
  type GatewayMethodName,
  type GatewayMethods,
  type GatewayToClient,
  type MethodName,
} from "@anymcp/shared";
import { answerApproval, getApproval } from "./bg/approval.js";
import { answerAsk, getAsk } from "./bg/ask.js";
import { handlers } from "./bg/handlers.js";
import { answerAllow, configureAccess, getAllowRequest } from "./bg/access.js";
import { configureLearning, flushStale } from "./bg/learn.js";
import { addCapture, clearCaptures, getRecording, startRecording, stopRecording } from "./bg/recording.js";
import { scanTab } from "./bg/scan.js";
import { openSetupWindow } from "./bg/setup.js";
import { cleanupHelperTabs } from "./bg/tabs.js";
import { STATUS_KEY, type ConnectionStatus, type PanelMessage, type Reply, type StatusInfo } from "./messages.js";

const VERSION = chrome.runtime.getManifest().version;
const PING_MS = 20_000; // WebSocket activity keeps the service worker alive (Chrome 116+).
const MAX_RETRY_MS = 30_000;
const GATEWAY_TIMEOUT_MS = 30_000;
/** How long a gateway handover may take before the panel shows "disconnected". */
const HANDOVER_GRACE_MS = 15_000;

let socket: WebSocket | null = null;
let connecting = false;
let status: ConnectionStatus = "disconnected";
let gatewayVersion: string | undefined;
let retryMs = 1_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
/** Set while a gateway hands over to a newer one: reconnect quickly and keep the status as is. */
let handoverUntil = 0;

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

// ---- Status -----------------------------------------------------------------

function setStatus(next: ConnectionStatus): void {
  // During a handover the old gateway is gone for a moment: not worth flashing "disconnected".
  if (next !== "connected" && next !== "auth-failed" && Date.now() < handoverUntil) return;
  if (next === "connected") handoverUntil = 0;
  status = next;
  if (next !== "connected") gatewayVersion = undefined;
  const info: StatusInfo = { status, gatewayVersion };
  void chrome.storage.session.set({ [STATUS_KEY]: info });
  // Waiting for the AI app is normal; only a failed pairing needs attention.
  void chrome.action.setBadgeText({ text: next === "auth-failed" ? "!" : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  const titles: Record<ConnectionStatus, string> = {
    connected: "AnyMCP: connected",
    connecting: "AnyMCP: connecting…",
    disconnected: "AnyMCP: waiting for your AI app",
    "auth-failed": "AnyMCP: pairing failed",
  };
  void chrome.action.setTitle({ title: titles[next] });
}

// ---- Connection -------------------------------------------------------------

async function getSettings(): Promise<{ token?: string; port: number }> {
  const s = await chrome.storage.local.get(["token", "port"]);
  return {
    token: typeof s.token === "string" && s.token ? s.token : undefined,
    port: typeof s.port === "number" ? s.port : DEFAULT_PORT,
  };
}

function send(ws: WebSocket, msg: ClientToGateway): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function rejectPending(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

async function gatewayIsUp(port: number): Promise<boolean> {
  try {
    // The gateway answers plain HTTP (426 Upgrade Required); "no-cors" needs no permission.
    await fetch(`http://127.0.0.1:${port}/`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

async function connect(): Promise<void> {
  if (connecting || socket) return;
  connecting = true;
  try {
    clearTimeout(retryTimer);
    // The gateway recognises this extension by its fixed ID; a stored token is only needed for
    // other browsers or unofficial builds.
    const { token, port } = await getSettings();
    // Chrome logs every refused WebSocket as an extension error, and the gateway is often not
    // running (no AI app open). A quiet fetch first checks it's there; a refused fetch isn't logged.
    if (!(await gatewayIsUp(port))) {
      setStatus("disconnected");
      const handingOver = Date.now() < handoverUntil;
      retryTimer = setTimeout(() => void connect(), handingOver ? 500 : retryMs);
      if (!handingOver) retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      return;
    }
    setStatus("connecting");
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    socket = ws;

    ws.onopen = () => send(ws, { type: "hello", token: token ?? "", role: "extension", version: VERSION });
    ws.onmessage = (ev) => void onMessage(ws, ev.data);
    ws.onclose = (ev) => {
      if (socket !== ws) return; // a socket we already replaced
      socket = null;
      clearInterval(pingTimer);
      rejectPending("The AnyMCP gateway disconnected.");
      if (ev.code === CLOSE_AUTH_FAILED) {
        setStatus("auth-failed"); // wait for the user to enter a token
        return;
      }
      if (ev.code === CLOSE_HANDOVER) {
        // A newer gateway is taking over the port: reconnect to it right away.
        handoverUntil = Date.now() + HANDOVER_GRACE_MS;
        retryMs = 500;
        setTimeout(() => {
          // Still not welcomed by the new gateway (a welcome clears handoverUntil): show the truth.
          if (handoverUntil === 0 || Date.now() < handoverUntil) return;
          handoverUntil = 0;
          setStatus(socket ? "connecting" : "disconnected");
        }, HANDOVER_GRACE_MS + 100);
      }
      setStatus("disconnected");
      retryTimer = setTimeout(() => void connect(), retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };
  } finally {
    connecting = false;
  }
}

function reconnectNow(): void {
  retryMs = 1_000;
  clearTimeout(retryTimer);
  const old = socket;
  socket = null;
  clearInterval(pingTimer);
  rejectPending("Reconnecting to the AnyMCP gateway.");
  old?.close();
  void connect();
}

async function onMessage(ws: WebSocket, data: unknown): Promise<void> {
  let msg: GatewayToClient;
  try {
    msg = JSON.parse(String(data));
  } catch {
    return;
  }

  switch (msg.type) {
    case "welcome":
      gatewayVersion = msg.gatewayVersion;
      retryMs = 1_000;
      setStatus("connected");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send(ws, { type: "ping" }), PING_MS);
      return;

    case "pong":
      return;

    case "response": {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
      return;
    }

    case "request": {
      const handler = (handlers as Record<string, ((params: unknown) => Promise<unknown>) | undefined>)[msg.method];
      if (!handler) {
        send(ws, { type: "response", id: msg.id, ok: false, error: `The extension doesn't support "${msg.method}". Update it.` });
        return;
      }
      try {
        const result = await handler((msg.params ?? {}) as never);
        send(ws, { type: "response", id: msg.id, ok: true, result });
      } catch (err) {
        send(ws, { type: "response", id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) });
      }
      return;
    }
  }
}

/** Calls a GatewayMethods method on the gateway. */
export function callGateway<M extends GatewayMethodName>(
  method: M,
  params: GatewayMethods[M]["params"],
): Promise<GatewayMethods[M]["result"]> {
  const ws = socket;
  if (!ws || status !== "connected") {
    return Promise.reject(new Error("AnyMCP isn't running. Open an AI app that uses AnyMCP (it starts AnyMCP)."));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The gateway didn't answer "${method}" in time.`));
    }, GATEWAY_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    send(ws, { type: "request", id, method, params });
  });
}

// ---- Learning ---------------------------------------------------------------

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
configureAccess({ onGranted: () => registerPageHooks() });

configureLearning({
  learn: (params) => callGateway("learn", params),
  onLearned: (count) => {
    clearTimeout(badgeTimer);
    void chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
    void chrome.action.setBadgeText({ text: `+${count}` });
    void chrome.action.setTitle({ title: `AnyMCP learned ${count} new tool(s) from your AI's work` });
    badgeTimer = setTimeout(() => setStatus(status), 5_000);
  },
});

// ---- Messages from extension pages -----------------------------------------

async function handlePanelMessage(msg: PanelMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case "status":
      return { status, gatewayVersion } satisfies StatusInfo;
    case "settings-changed":
      reconnectNow();
      return { ok: true };
    case "gateway":
      return callGateway(msg.method as GatewayMethodName, msg.params as never);
    case "scan":
      return scanTab(msg.tabId);
    case "record-start":
      await startRecording(msg.tabId);
      return getRecording(msg.tabId);
    case "record-stop":
      await stopRecording(msg.tabId);
      return getRecording(msg.tabId);
    case "record-get":
      return getRecording(msg.tabId);
    case "record-clear":
      await clearCaptures(msg.tabId);
      return getRecording(msg.tabId);
    case "approval-get":
      return getApproval(msg.id);
    case "approval":
      answerApproval(msg.id, msg.choice);
      return { ok: true };
    case "ask-get":
      return getAsk(msg.id);
    case "ask-answer":
      answerAsk(msg.id, msg.choice, msg.text);
      return { ok: true };
    case "captured":
      if (sender.tab?.id !== undefined) await addCapture(sender.tab.id, msg.request);
      return { ok: true };
    case "open-setup":
      await openSetupWindow(msg.url);
      return { ok: true };
    case "register-hooks":
      await registerPageHooks();
      return { ok: true };
    case "allow-get":
      return getAllowRequest(msg.id);
    case "allow-answer":
      await answerAllow(msg.id, Boolean(msg.granted));
      return { ok: true };
    default:
      throw new Error("Unknown message.");
  }
}

const PAGE_ONLY = new Set(["captured"]);

chrome.runtime.onMessage.addListener((msg: PanelMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return;
  // Content scripts may only send captures; everything else must come from extension pages.
  const fromExtensionPage = !sender.tab || sender.url?.startsWith(chrome.runtime.getURL(""));
  if (!fromExtensionPage && !PAGE_ONLY.has(msg.type)) return;
  handlePanelMessage(msg, sender).then(
    (result) => sendResponse({ ok: true, result } satisfies Reply),
    (err) => sendResponse({ ok: false, error: (err as Error)?.message ?? String(err) } satisfies Reply),
  );
  return true; // async response
});

// ---- Lifecycle --------------------------------------------------------------

/** Page hooks that run on every site the user allowed: WebMCP tools and live session values. */
async function registerPageHooks(): Promise<void> {
  const hooks = [
    { id: "anymcp-webmcp", js: ["page/webmcp.js"] },
    { id: "anymcp-live", js: ["page/live.js"] },
  ];
  for (const hook of hooks) {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [hook.id] });
      if (existing.length) continue;
      await chrome.scripting.registerContentScripts([
        { ...hook, matches: ["<all_urls>"], runAt: "document_start", world: "MAIN", allFrames: false },
      ]);
    } catch {
      // Already registered, or not supported.
    }
  }
}

function startup(): void {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void registerPageHooks();
  void connect();
}

// If Chrome stops the worker anyway, this alarm wakes it, reconnects and tidies helper tabs.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return;
  void connect();
  void cleanupHelperTabs();
  void flushStale();
});
chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);

// Typing check: every protocol method has a handler.
const _check: Record<MethodName, unknown> = handlers;
void _check;

startup();
