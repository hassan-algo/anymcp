// "Ask the user and wait": the gateway needs the user (sign in, pick an option, a short answer).
// Optionally opens or focuses a tab first, then shows ask.html. One question at a time.

import type { AskUserRequest, AskUserResult } from "@anymcp/shared";
import { PopupRequests } from "./popup.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const CANCEL = /^(cancel|not now|no)$/i;
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sign_in|accounts\/login|auth|session)/i;

const popups = new PopupRequests<AskUserRequest, AskUserResult>("ask.html", { width: 440, height: 420 }, { cancelled: true });
let queue: Promise<unknown> = Promise.resolve();

export function askUser(req: AskUserRequest): Promise<AskUserResult> {
  const turn = queue.then(() => show(req));
  queue = turn.catch(() => undefined);
  return turn;
}

export function getAsk(id: string): AskUserRequest | null {
  return popups.get(id);
}

export function answerAsk(id: string, choice: string, text?: string): void {
  const req = popups.get(id);
  if (!req) return;
  const choices = req.choices?.length ? req.choices : ["OK", "Cancel"];
  if (!choices.includes(choice)) return;
  popups.answer(id, { choice, ...(req.input ? { text: (text ?? "").slice(0, 2000) } : {}), cancelled: CANCEL.test(choice) });
}

async function show(req: AskUserRequest): Promise<AskUserResult> {
  let near: number | undefined;
  try {
    if (req.focusTabId !== undefined) {
      const tab = await chrome.tabs.update(req.focusTabId, { active: true });
      if (tab?.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
        near = tab.windowId;
      }
    } else if (req.openUrl && /^https?:\/\//i.test(req.openUrl)) {
      near = await openOrFocus(req.openUrl);
    }
  } catch {
    // The question still matters even if the tab couldn't be shown.
  }
  return popups.open(req, { timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, near });
}

/** Focuses a tab on that URL (or that site's sign-in page) if one is open, else opens it. Returns its window. */
async function openOrFocus(url: string): Promise<number | undefined> {
  const target = new URL(url);
  const tabs = await chrome.tabs.query({});
  const same = (t: chrome.tabs.Tab) => {
    try {
      const u = new URL(t.url ?? "");
      return u.href === target.href || (u.origin === target.origin && LOGIN_PATH.test(u.pathname));
    } catch {
      return false;
    }
  };
  const existing = tabs.find(same);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return existing.windowId;
  }
  let windowId: number | undefined;
  try {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  } catch {
    windowId = undefined;
  }
  if (windowId === undefined) {
    const w = await chrome.windows.create({ url, type: "normal", focused: true });
    return w?.id;
  }
  await chrome.tabs.create({ windowId, url, active: true });
  await chrome.windows.update(windowId, { focused: true });
  return windowId;
}
