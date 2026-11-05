// Approval windows: the gateway asks, the user picks a choice in approve.html.

import type { ApprovalChoice, ApprovalRequest } from "@anymcp/shared";
import { PopupRequests } from "./popup.js";

const TIMEOUT_MS = 120_000;
const popups = new PopupRequests<ApprovalRequest, { choice: ApprovalChoice }>("approve.html", { width: 420, height: 520 }, { choice: "deny" });

export function requestApproval(request: ApprovalRequest): Promise<{ choice: ApprovalChoice }> {
  return popups.open(request, { timeoutMs: TIMEOUT_MS });
}

export function getApproval(id: string): ApprovalRequest | null {
  return popups.get(id);
}

export function answerApproval(id: string, choice: ApprovalChoice): void {
  const req = popups.get(id);
  if (!req) return;
  popups.answer(id, { choice: req.choices.includes(choice) ? choice : "deny" });
}
