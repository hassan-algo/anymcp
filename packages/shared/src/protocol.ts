// Messages on the local WebSocket.
//
// The gateway listens on 127.0.0.1. Two kinds of clients connect:
// - the browser extension (role "extension")
// - other gateway processes (role "peer"), when several AI clients run AnyMCP at once. Only the
//   first gateway owns the port; the others connect to it and forward browser calls through it.
//
// Every client starts with `hello` (pairing token) and waits for `welcome`. After that both sides
// can send `request`s and answer with `response`s (JSON-RPC style, ids are per sender).

import type { CapturedRequest } from "./infer.js";
import type { Auth, Category, ProfileList, Tool } from "./profile.js";
import type { ResolvedFormAction, ResolvedHttpRequest, ResolvedPageAction } from "./template.js";

export const DEFAULT_PORT = 17872;

/**
 * IDs of the official AnyMCP extension builds. The gateway trusts a connection from one of these
 * without a pairing token: Chrome sets the Origin header itself, so other extensions and websites
 * can't pretend to be one. Add the Chrome Web Store ID here once it's published.
 */
export const TRUSTED_EXTENSION_IDS = [
  "bgcgfbimbddjmojlkbhknlihafjmmacc", // Chrome Web Store
  "lakpncfioijpankpckjhpmpielbempik", // unpacked builds (the manifest "key")
];

/** Close code the gateway uses when the pairing token is wrong. */
export const CLOSE_AUTH_FAILED = 4001;
/** The gateway is handing its port to a newer gateway: reconnect right away. */
export const CLOSE_HANDOVER = 4002;

// ---- Shared shapes ----------------------------------------------------------

export interface TabInfo {
  id: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
}

export interface PageContent {
  tabId: number;
  title: string;
  url: string;
  text: string;
  truncated: boolean;
  /** Size of the page's HTML (characters), to show how much reading only the text saved. */
  htmlChars?: number;
}

export interface PageElement {
  /** Pass this to click/fill. Valid until the page reloads. */
  ref: string;
  role: string;
  name: string;
  href?: string;
  value?: string;
  type?: string;
}

export interface ActionResult {
  tabId: number;
  url: string;
  title: string;
  note?: string;
}

export interface HttpResult {
  status: number;
  url: string;
  contentType: string;
  body: string;
  /** Browser placeholders ("live:fb_dtsg", "cookie:x"…) that had no value, so were left out. */
  missing?: string[];
  /** The response's Retry-After header, if any. */
  retryAfter?: string;
}

export type ApprovalChoice = "once" | "always" | "deny";

export interface ApprovalRequest {
  title: string;
  message: string;
  /** Extra lines shown as a list, e.g. the arguments of the call. */
  details?: string[];
  choices: ApprovalChoice[];
}

/** A question for the user, shown in a small browser window. The call waits for the answer. */
export interface AskUserRequest {
  title: string;
  message: string;
  /** Buttons to choose from, e.g. ["I've signed in", "Cancel"]. Default: ["OK", "Cancel"]. */
  choices?: string[];
  /** Ask for a short text answer too (never a password: sign-ins happen on the site itself). */
  input?: { label: string; placeholder?: string };
  /** Open (or focus) this page first, e.g. the site's sign-in page. */
  openUrl?: string;
  /** Bring this tab to the front first. */
  focusTabId?: number;
  /** How long to wait (ms). Default 5 minutes. */
  timeoutMs?: number;
}

export interface AskUserResult {
  /** The button clicked. Missing when the window was closed or timed out. */
  choice?: string;
  text?: string;
  /** Closed, timed out, or "Cancel". */
  cancelled: boolean;
}

// ---- Gateway -> extension ---------------------------------------------------

export interface ExtensionMethods {
  list_tabs: { params: Record<string, never>; result: TabInfo[] };
  read_page: { params: { tabId?: number; maxChars?: number }; result: PageContent };
  /** Lists links, buttons and inputs, giving each a ref for click/fill. */
  find_elements: {
    params: { tabId?: number; query?: string; limit?: number };
    result: { tabId: number; url: string; elements: PageElement[] };
  };
  click: { params: { tabId?: number; ref?: string; selector?: string }; result: ActionResult };
  fill: {
    params: { tabId?: number; ref?: string; selector?: string; value: string; submit?: boolean };
    result: ActionResult;
  };
  navigate: { params: { url: string; tabId?: number; newTab?: boolean }; result: TabInfo };
  screenshot: { params: { tabId?: number }; result: { tabId: number; mimeType: "image/png"; data: string } };
  /** Runs a request from inside a tab on one of `origins`, with the user's cookies. */
  run_http: {
    params: { origins: string[]; allowedHosts: string[]; request: ResolvedHttpRequest };
    result: HttpResult;
  };
  /** Opens `action.page` in a background tab, fills and submits the form, returns the result text. */
  run_form: { params: { allowedHosts: string[]; action: ResolvedFormAction }; result: PageContent };
  /** Opens `action.url` in a background tab, waits, returns the page's main text. */
  run_page: { params: { allowedHosts: string[]; action: ResolvedPageAction }; result: PageContent };
  /** Calls a tool the page registered through WebMCP. */
  run_webmcp: {
    params: { allowedHosts: string[]; page: string; tool: string; args: Record<string, unknown> };
    result: { text: string };
  };
  /**
   * Looks for ready-made tools on a tab's site: its forms, WebMCP tools, an OpenAPI description, and
   * an official profile at /.well-known/anymcp.json. Returns them as tools (not saved).
   */
  scan_tab: {
    params: { tabId?: number };
    result: { url: string; tools: Tool[]; allowedHosts: string[]; notes: string[]; official?: unknown };
  };
  /** Opens the "Add a site" setup window (optionally for a URL): allow access, then record. */
  open_setup: { params: { url?: string }; result: { opened: true } };
  /** Asks the user something in a small window and waits for the answer. */
  ask_user: { params: AskUserRequest; result: AskUserResult };
  /** Shows an approval window in the browser. */
  request_approval: { params: ApprovalRequest; result: { choice: ApprovalChoice } };
}

// ---- Extension -> gateway ---------------------------------------------------

export interface ProfileSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  /** Where it came from. "local" profiles (yours) win over registry ones with the same id. */
  /** "mcp": tools of another MCP server connected through AnyMCP. */
  source: "local" | "registry" | "bundled" | "mcp";
  official: boolean;
  auth: Auth;
  categories: string[];
  origins: string[];
  allowedHosts: string[];
  tools: {
    name: string;
    title: string;
    description: string;
    mutates: boolean;
    /** "http" | "form" | "page" | "webmcp". Optional for older gateways. */
    kind?: string;
    /** Where it runs. Optional for older gateways. */
    runsIn?: "gateway" | "browser";
  }[];
  approved: boolean;
  pinned: boolean;
}

export interface Overview {
  gatewayVersion: string;
  registryUpdatedAt?: string;
  registryRepo?: string;
  /** Profiles for the page the user is on. */
  matching: ProfileSummary[];
  /** Your own profiles (made in the extension or imported). */
  local: ProfileSummary[];
  categories: Category[];
  lists: (ProfileList & { pinned: boolean })[];
}

/** Token use, estimated as characters / 4. */
export interface UsageStats {
  since: string;
  calls: number;
  /** What the sites sent back, before AnyMCP trimmed it. */
  rawTokens: number;
  /** What the AI actually received. */
  returnedTokens: number;
  savedTokens: number;
  savedPercent: number;
  /** Estimate of everything: API savings, page reads (HTML vs text), and MCP tool definitions kept out of context. */
  totalSavedTokens: number;
  totalPercent: number;
  sites: {
    id: string;
    /** "mcp": another MCP server connected through AnyMCP. */
    kind: "site" | "mcp";
    calls: number;
    rawTokens: number;
    returnedTokens: number;
    savedTokens: number;
    pageCalls: number;
    pageHtmlTokens: number;
    pageTextTokens: number;
  }[];
  /**
   * Other MCP servers connected through AnyMCP. Two savings: their results are trimmed
   * (savedTokens), and their tool definitions stay out of every AI conversation.
   */
  mcp: {
    calls: number;
    savedTokens: number;
    /** AI sessions started since `since`; each one would have loaded every server's tool definitions. */
    sessions: number;
    /** Tool-definition tokens kept out of those sessions, minus what describe_tool showed (an estimate, on the low side). */
    definitionsSavedTokens: number;
    servers: { id: string; name: string; toolCount: number; definitionTokens: number; calls: number; savedTokens: number }[];
  };
  /** Page reads (open a page, return its text): the AI got the text instead of the page's HTML. Not counted in savedTokens. */
  pages: { calls: number; htmlTokens: number; textTokens: number };
  /** Tool definitions the AI keeps in context, vs. listing every tool of every site. */
  toolList: { toolCount: number; loadedTokens: number; allToolsTokens: number; savedTokens: number };
  /** Sites AnyMCP has paused because they pushed back (captcha, too many requests…). */
  paused?: { site: string; until: number; reason: string }[];
}

export interface GatewayMethods {
  get_overview: { params: { url?: string }; result: Overview };
  get_profile: { params: { id: string }; result: unknown };
  /** Validates and saves a profile as a local profile. */
  save_profile: { params: { profile: unknown }; result: { id: string } };
  delete_profile: { params: { id: string }; result: { ok: true } };
  set_approval: { params: { profileId: string; approved: boolean }; result: { ok: true } };
  /** target is a profile id or "list:<id>". */
  set_pinned: { params: { target: string; pinned: boolean }; result: { ok: true } };
  set_settings: { params: { registryRepo?: string; registryUrl?: string }; result: { ok: true } };
  get_stats: { params: Record<string, never>; result: UsageStats };
  /**
   * The AI just did something on a site with the browser tools. These are the requests the site made
   * right after each action; the gateway turns new ones into tools so next time it's one call.
   */
  learn: { params: { url: string; requests: CapturedRequest[] }; result: { added: string[]; known: number; profileId?: string } };
  reset_stats: { params: Record<string, never>; result: { ok: true } };
  /** Re-download the community registry now. */
  sync_registry: { params: Record<string, never>; result: { ok: true; profiles: number } };
  /** Ends a site's pause early, once the user has cleared the site's check. */
  resume_site: { params: { site: string }; result: { ok: true } };
}

/** Peer gateways forward browser calls to the gateway that owns the extension connection. */
export interface PeerMethods {
  forward: { params: { method: keyof ExtensionMethods; params: unknown; timeoutMs?: number }; result: unknown };
}

export type MethodName = keyof ExtensionMethods;
export type GatewayMethodName = keyof GatewayMethods;

// ---- Envelopes --------------------------------------------------------------

export interface RpcRequest {
  type: "request";
  id: number;
  method: string;
  params: unknown;
}

export type RpcResponse =
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: string };

export type Hello = {
  type: "hello";
  token: string;
  role: "extension" | "peer";
  version: string;
  /** Gateways only: when this gateway was built. A newer one takes over from an older one. */
  build?: number;
};

export type GatewayToClient = { type: "welcome"; gatewayVersion: string } | { type: "pong" } | RpcRequest | RpcResponse;

export type ClientToGateway = Hello | { type: "ping" } | RpcRequest | RpcResponse;
