// Asks the user something and waits: in a browser window when the extension is connected (always
// seen, even when the AI app can't show prompts), otherwise through the AI app's own prompt.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AskUserRequest, AskUserResult } from "@anymcp/shared";
import type { Bridge } from "./bridge.js";

/** Lets a long wait tell the AI app it's still working, so the call doesn't time out. */
export const callContext = new AsyncLocalStorage<{ progress?: (message: string) => void }>();

export type AskUser = (req: AskUserRequest) => Promise<AskUserResult>;

export class CantAskError extends Error {}

const CANCEL = /^(cancel|not now|no|skip)$/i;

export function createAskUser(deps: { bridge: Bridge; mcp: Server; log: (m: string) => void }): AskUser {
  return async (req) => {
    const timeoutMs = req.timeoutMs ?? 300_000;
    const progress = callContext.getStore()?.progress;
    const timer = progress ? setInterval(() => progress(`Waiting for you: ${req.title}`), 15_000) : undefined;
    try {
      if (deps.bridge.connected) {
        return await deps.bridge.call("ask_user", { ...req, timeoutMs }, timeoutMs + 15_000);
      }
      if (deps.mcp.getClientCapabilities()?.elicitation) {
        const choices = req.choices?.length ? req.choices : ["OK", "Cancel"];
        const properties: Record<string, unknown> = { choice: { type: "string", title: "Your choice", enum: choices } };
        if (req.input) properties.text = { type: "string", title: req.input.label, description: req.input.placeholder };
        const r = await deps.mcp.elicitInput({
          message: `${req.title}\n\n${req.message}${req.openUrl ? `\n\nOpen: ${req.openUrl}` : ""}`,
          requestedSchema: { type: "object", properties: properties as never, required: ["choice"] },
        });
        if (r.action !== "accept") return { cancelled: true };
        const choice = typeof r.content?.choice === "string" ? r.content.choice : undefined;
        const text = typeof r.content?.text === "string" ? r.content.text : undefined;
        return { choice, text, cancelled: !choice || CANCEL.test(choice) };
      }
      throw new CantAskError("There's no way to ask the user right now (the AnyMCP browser extension isn't connected and this AI app can't show prompts).");
    } finally {
      if (timer) clearInterval(timer);
    }
  };
}
