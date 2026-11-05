// The "Your AI wants to use <site>" window. Chrome only grants site access from a click here.

import type { Reply } from "./messages.js";

const TEST_DENY_KEY = "__testDenyOrigins";
const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "";
const titleEl = document.getElementById("title")!;
const messageEl = document.getElementById("message")!;
const allowBtn = document.getElementById("allow") as HTMLButtonElement;
const notNowBtn = document.getElementById("notnow") as HTMLButtonElement;

let origin = "";
let testMode = false;

async function answer(granted: boolean): Promise<void> {
  await chrome.runtime.sendMessage({ type: "allow-answer", id, granted });
  window.close();
}

async function main(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ type: "allow-get", id })) as Reply<{ origin: string } | null>;
  const req = reply.ok ? reply.result : null;
  if (!req) {
    titleEl.textContent = "Nothing to allow";
    messageEl.textContent = "This request already finished or timed out.";
    setTimeout(() => window.close(), 1500);
    return;
  }
  origin = req.origin;
  const host = new URL(origin).host;
  // Read before any click so the click handler can call permissions.request right away.
  const s = await chrome.storage.local.get(TEST_DENY_KEY);
  testMode = Array.isArray(s[TEST_DENY_KEY]) && (s[TEST_DENY_KEY] as string[]).includes(origin);
  titleEl.textContent = `Your AI wants to use ${host}`;
  messageEl.textContent = `Allow AnyMCP on ${host}? It can then read and use pages on this site for your AI, signed in as you.`;
  allowBtn.hidden = false;
  notNowBtn.hidden = false;
  notNowBtn.focus();
}

allowBtn.addEventListener("click", () => {
  if (testMode) {
    void answer(true);
    return;
  }
  chrome.permissions.request({ origins: [`${origin}/*`] }).then(
    (granted) => void answer(granted),
    () => void answer(false),
  );
});
notNowBtn.addEventListener("click", () => void answer(false));

void main();
