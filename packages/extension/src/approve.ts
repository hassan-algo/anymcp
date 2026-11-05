import type { ApprovalChoice, ApprovalRequest } from "@anymcp/shared";
import type { Reply } from "./messages.js";

const LABELS: Record<ApprovalChoice, string> = { once: "Allow once", always: "Always allow", deny: "Deny" };

const id = new URLSearchParams(location.search).get("id") ?? "";
const titleEl = document.getElementById("title")!;
const messageEl = document.getElementById("message")!;
const detailsEl = document.getElementById("details")!;
const choicesEl = document.getElementById("choices")!;

async function main(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ type: "approval-get", id })) as Reply<ApprovalRequest | null>;
  const req = reply.ok ? reply.result : null;
  if (!req) {
    titleEl.textContent = "Nothing to approve";
    messageEl.textContent = "This request already finished or timed out.";
    setTimeout(() => window.close(), 1500);
    return;
  }
  titleEl.textContent = req.title;
  messageEl.textContent = req.message;
  for (const d of req.details ?? []) {
    const li = document.createElement("li");
    li.textContent = d;
    detailsEl.append(li);
  }
  // Deny last, and the safe choice gets focus.
  const order: ApprovalChoice[] = ["once", "always", "deny"];
  for (const choice of order.filter((c) => req.choices.includes(c))) {
    const b = document.createElement("button");
    b.textContent = LABELS[choice];
    if (choice === "once" || (choice === "always" && !req.choices.includes("once"))) b.className = "primary";
    if (choice === "deny") b.className = "danger";
    b.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "approval", id, choice });
      window.close();
    });
    choicesEl.append(b);
    if (choice === "deny") b.focus();
  }
}

void main();
