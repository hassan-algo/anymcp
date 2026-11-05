// Asks the user before AnyMCP acts for them.
// - First use of a site's tools: allow always / deny.
// - Tools that change data (mutates: true): once / always / deny, every call unless "always".

import { effectiveAuth, type ApprovalChoice, type ApprovalRequest, type Profile, type Tool } from "@anymcp/shared";
import { loadState, updateState, type Paths } from "./config.js";
import { defaultPace, LIMITS, siteKey } from "./pacing.js";

/** A heads-up for sites that restrict accounts acting automated. */
export function riskNote(profile: Profile): string {
  const site = siteKey(profile.origins[0] ?? profile.allowedHosts[0] ?? profile.id);
  const usesLogin = profile.tools.some((t) => effectiveAuth(profile, t) === "browser-session");
  if (!usesLogin || defaultPace(site, "browser-session", profile.pace) !== "strict") return "";
  const L = LIMITS.strict;
  return (
    ` Heads-up: ${profile.name} limits accounts that look automated, and its terms may not allow automated use. ` +
    `AnyMCP goes slowly here (calls a few seconds apart, at most ${L.actsPerDay} posts, likes, follows or messages a day) ` +
    `and stops if the site pushes back, but you use it at your own risk.`
  );
}

/**
 * Shows an approval prompt somewhere. "unavailable": there's nowhere to show it.
 * "dismissed": the AI app closed its prompt without an answer (some do this automatically).
 */
export type Asker = (req: ApprovalRequest) => Promise<ApprovalChoice | "unavailable" | "dismissed">;

export class ApprovalError extends Error {}

function describeArgs(args: Record<string, unknown>): string[] {
  return Object.entries(args).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${s.length > 200 ? `${s.slice(0, 200)}…` : s}`;
  });
}

export class Approvals {
  constructor(
    private readonly paths: Paths,
    private readonly ask: Asker,
  ) {}

  async check(profile: Profile, tool: Tool, args: Record<string, unknown>): Promise<void> {
    const state = loadState(this.paths);
    const approval = state.approvals[profile.id];

    // MCP servers were added by the user themselves; only changes to data need asking.
    if (!approval?.site && tool.action.kind !== "mcp") {
      const choice = await this.ask({
        title: `Allow AnyMCP to use ${profile.name}?`,
        message:
          `Your AI wants to use "${tool.title}" from ${profile.name} (${profile.id}). ` +
          `Its tools can reach: ${profile.allowedHosts.join(", ")}.` +
          (profile.tools.some((t) => effectiveAuth(profile, t) === "browser-session")
            ? " Some or all of them run in your browser, signed in as you."
            : "") +
          riskNote(profile),
        details: profile.tools.map((t) => `${t.title}${t.mutates ? " (changes data)" : ""}`),
        choices: ["always", "deny"],
      });
      this.ensure(choice, profile);
      updateState((s) => {
        s.approvals[profile.id] = { site: true, alwaysTools: s.approvals[profile.id]?.alwaysTools ?? [] };
      }, this.paths);
    }

    if (tool.mutates && !loadState(this.paths).approvals[profile.id]?.alwaysTools.includes(tool.name)) {
      const choice = await this.ask({
        title: `${tool.title} on ${profile.name}?`,
        message: `Your AI wants to run "${tool.title}" on ${profile.name}. This can change your data on the site.`,
        details: describeArgs(args),
        choices: ["once", "always", "deny"],
      });
      this.ensure(choice, profile);
      if (choice === "always") {
        updateState((s) => {
          const a = (s.approvals[profile.id] ??= { site: true, alwaysTools: [] });
          if (!a.alwaysTools.includes(tool.name)) a.alwaysTools.push(tool.name);
        }, this.paths);
      }
    }
  }

  private ensure(choice: ApprovalChoice | "unavailable" | "dismissed", profile: Profile): void {
    const howTo =
      `Approve ${profile.name} by running \`anymcp allow ${profile.id}\` (or \`npx -y anymcp-gateway allow ${profile.id}\`), ` +
      `from the AnyMCP side panel in Chrome, or connect the AnyMCP extension so it can ask you there. Then try again.`;
    if (choice === "unavailable") {
      throw new ApprovalError(
        `This needs your approval, but there's no way to ask right now (your AI app doesn't support prompts and ` +
          `the AnyMCP browser extension isn't connected). ${howTo}`,
      );
    }
    if (choice === "dismissed") {
      throw new ApprovalError(
        `This needs your approval, but the AI app's prompt closed without an answer. Some apps do this ` +
          `automatically when they can't show prompts. ${howTo}`,
      );
    }
    if (choice === "deny") throw new ApprovalError(`The user declined this request for ${profile.name}.`);
  }
}

/** Sets or clears approval for a whole site. */
export function setSiteApproval(paths: Paths, profileId: string, approved: boolean): void {
  updateState((s) => {
    if (approved) s.approvals[profileId] = { site: true, alwaysTools: s.approvals[profileId]?.alwaysTools ?? [] };
    else delete s.approvals[profileId];
  }, paths);
}
