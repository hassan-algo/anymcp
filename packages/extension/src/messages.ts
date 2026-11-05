// Messages between extension pages (side panel, setup, approval, ask and allow windows, page relays) and the background.

import type { ApprovalChoice, CapturedRequest, FormDescriptor } from "@anymcp/shared";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "auth-failed";

export interface StatusInfo {
  status: ConnectionStatus;
  gatewayVersion?: string;
}

export interface WebMcpToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface ScanResult {
  url: string;
  forms: FormDescriptor[];
  /** Forms skipped because they ask for a password. */
  skippedLoginForms: number;
  webmcp: WebMcpToolInfo[];
  openapi?: { url: string; doc: Record<string, unknown> };
  /** Contents of /.well-known/anymcp.json, if the site has one. */
  official?: unknown;
}

export type PanelMessage =
  | { type: "status" }
  | { type: "settings-changed" }
  | { type: "gateway"; method: string; params: unknown }
  | { type: "scan"; tabId: number }
  | { type: "record-start"; tabId: number }
  | { type: "record-stop"; tabId: number }
  | { type: "record-get"; tabId: number }
  | { type: "record-clear"; tabId: number }
  | { type: "approval-get"; id: string }
  | { type: "approval"; id: string; choice: ApprovalChoice }
  | { type: "ask-get"; id: string }
  | { type: "ask-answer"; id: string; choice: string; text?: string }
  | { type: "captured"; request: unknown }
  | { type: "open-setup"; url?: string }
  | { type: "register-hooks" }
  | { type: "allow-get"; id: string }
  | { type: "allow-answer"; id: string; granted: boolean };

export type Reply<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export interface RecordingInfo {
  recording: boolean;
  requests: CapturedRequest[];
}

/** storage.session keys */
export const STATUS_KEY = "status";
export const RECORDING_KEY = "recordingTabs";
export const captureKey = (tabId: number) => `rec:${tabId}`;

/** storage.session: the setup window's progress, so it can pick up again after a reload. */
export const SETUP_KEY = "setup";
export interface SetupState {
  origin: string;
  tabId: number;
}

/** Learning from the AI's browser work (storage.session). */
export const LEARN_TABS_KEY = "learningTabs";
export const learnCaptureKey = (tabId: number) => `learncap:${tabId}`;
export const learnStateKey = (tabId: number) => `learnstate:${tabId}`;
export interface LearnState {
  /** Page the AI was on when it started. */
  startUrl: string;
  /** Sites (origins) the recorder runs on for this tab. */
  origins: string[];
  /** When each AI action happened. */
  actions: { at: number; url?: string }[];
}
export interface LearnTab {
  tabId: number;
  origins: string[];
}

/** storage.local */
export const LEARN_SETTING = "learn";
/** Last site the gateway made or updated a profile for from learning: {at, host, profileId}. */
export const LEARNED_PROFILE_KEY = "learnedProfile";
