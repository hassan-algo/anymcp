// Counts how much text AnyMCP saves the AI. Stored in ~/.anymcp/stats.json.
// Tokens are estimated as characters / 4 (close enough for English text and JSON).

import fs from "node:fs";
import path from "node:path";
import { pinnedToolName, type UsageStats } from "@anymcp/shared";
import { writeFileAtomic, type Paths } from "./config.js";
import type { Catalog } from "./catalog.js";

interface SiteCount {
  calls: number;
  rawChars: number;
  returnedChars: number;
  pageCalls?: number;
  pageHtmlChars?: number;
  pageTextChars?: number;
}

interface StatsFile {
  since: string;
  sites: Record<string, SiteCount>;
  /** Size of the tool list the AI last received (saved so the CLI can report it). */
  listedChars?: number;
  /** AI sessions started, and the MCP server tool definitions each would have loaded. */
  sessions?: number;
  mcpDefinitionChars?: number;
  /** describe_tool output for MCP server tools: the part of their definitions the AI did see. */
  mcpDescribedChars?: number;
}

/** Characters a tool definition takes in an AI's tool list. */
export function definitionChars(profileId: string, tools: { name: string; description: string; input: unknown }[]): number {
  return tools.reduce((n, t) => n + JSON.stringify({ name: pinnedToolName(profileId, t.name), description: t.description, inputSchema: t.input }).length, 0);
}

/** A new AI session started: count the MCP server tool definitions it didn't have to load. */
export function recordSession(paths: Paths, mcpDefinitionChars: number): void {
  try {
    const s = load(paths);
    s.sessions = (s.sessions ?? 0) + 1;
    s.mcpDefinitionChars = (s.mcpDefinitionChars ?? 0) + mcpDefinitionChars;
    writeFileAtomic(file(paths), JSON.stringify(s, null, 2) + "\n");
  } catch {
    // never break the server
  }
}

/** The AI looked up an MCP server tool with describe_tool: that part wasn't saved. */
export function recordDescribed(paths: Paths, chars: number): void {
  try {
    const s = load(paths);
    s.mcpDescribedChars = (s.mcpDescribedChars ?? 0) + chars;
    writeFileAtomic(file(paths), JSON.stringify(s, null, 2) + "\n");
  } catch {
    // never break a tool call
  }
}

export const tokensOf = (chars: number) => Math.round(chars / 4);

function file(paths: Paths): string {
  return path.join(paths.home, "stats.json");
}

function load(paths: Paths): StatsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file(paths), "utf8")) as Partial<StatsFile>;
    if (raw && typeof raw.since === "string" && raw.sites && typeof raw.sites === "object") return raw as StatsFile;
  } catch {
    // first run
  }
  return { since: new Date().toISOString(), sites: {} };
}

/** Adds one call. rawChars = what the site sent; returnedChars = what the AI got. */
export function recordUsage(paths: Paths, profileId: string, rawChars: number, returnedChars: number): void {
  try {
    const s = load(paths);
    const c = (s.sites[profileId] ??= { calls: 0, rawChars: 0, returnedChars: 0 });
    c.calls += 1;
    c.rawChars += Math.max(rawChars, returnedChars);
    c.returnedChars += returnedChars;
    writeFileAtomic(file(paths), JSON.stringify(s, null, 2) + "\n");
  } catch {
    // Stats must never break a tool call.
  }
}

/** Adds one page read: the page's HTML size vs the text the AI got. */
export function recordPageRead(paths: Paths, profileId: string, htmlChars: number, textChars: number): void {
  try {
    const s = load(paths);
    const c = (s.sites[profileId] ??= { calls: 0, rawChars: 0, returnedChars: 0 });
    c.pageCalls = (c.pageCalls ?? 0) + 1;
    c.pageHtmlChars = (c.pageHtmlChars ?? 0) + Math.max(htmlChars, textChars);
    c.pageTextChars = (c.pageTextChars ?? 0) + textChars;
    writeFileAtomic(file(paths), JSON.stringify(s, null, 2) + "\n");
  } catch {
    // Stats must never break a tool call.
  }
}

export function setListedChars(paths: Paths, chars: number): void {
  try {
    const s = load(paths);
    if (s.listedChars === chars) return;
    s.listedChars = chars;
    writeFileAtomic(file(paths), JSON.stringify(s, null, 2) + "\n");
  } catch {
    // ignore
  }
}

export function resetStats(paths: Paths): void {
  const old = load(paths);
  writeFileAtomic(file(paths), JSON.stringify({ since: new Date().toISOString(), sites: {}, listedChars: old.listedChars }, null, 2) + "\n");
}

/** `listedChars`: size of the tool list the AI actually sees (defaults to the last one saved). */
export function getStats(paths: Paths, catalog: Catalog, listedChars?: number): UsageStats {
  const s = load(paths);
  listedChars ??= s.listedChars ?? 0;
  const sites = Object.entries(s.sites)
    .map(([id, c]) => ({
      id,
      kind: (catalog.get(id)?.source === "mcp" || id.startsWith("mcp-") ? "mcp" : "site") as "site" | "mcp",
      calls: c.calls,
      rawTokens: tokensOf(c.rawChars),
      returnedTokens: tokensOf(c.returnedChars),
      savedTokens: tokensOf(c.rawChars - c.returnedChars),
      pageCalls: c.pageCalls ?? 0,
      pageHtmlTokens: tokensOf(c.pageHtmlChars ?? 0),
      pageTextTokens: tokensOf(c.pageTextChars ?? 0),
    }))
    .sort((a, b) => b.savedTokens - a.savedTokens || b.pageHtmlTokens - a.pageHtmlTokens);
  const raw = Object.values(s.sites).reduce((n, c) => n + c.rawChars, 0);
  const returned = Object.values(s.sites).reduce((n, c) => n + c.returnedChars, 0);

  let toolCount = 0;
  let allChars = 0;
  for (const entry of catalog.all()) {
    toolCount += entry.profile.tools.length;
    allChars += definitionChars(entry.profile.id, entry.profile.tools);
  }

  const mcpRows = sites.filter((x) => x.kind === "mcp");
  const servers = catalog
    .all()
    .filter((e) => e.source === "mcp")
    .map((e) => {
      const row = mcpRows.find((x) => x.id === e.profile.id);
      return {
        id: e.profile.id,
        name: e.profile.id.replace(/^mcp-/, ""),
        toolCount: e.profile.tools.length,
        definitionTokens: tokensOf(definitionChars(e.profile.id, e.profile.tools)),
        calls: row?.calls ?? 0,
        savedTokens: row?.savedTokens ?? 0,
      };
    });
  const definitionsSavedChars = Math.max(0, (s.mcpDefinitionChars ?? 0) - (s.mcpDescribedChars ?? 0));

  return {
    since: s.since,
    calls: sites.reduce((n, x) => n + x.calls, 0),
    pages: {
      calls: sites.reduce((n, x) => n + x.pageCalls, 0),
      htmlTokens: sites.reduce((n, x) => n + x.pageHtmlTokens, 0),
      textTokens: sites.reduce((n, x) => n + x.pageTextTokens, 0),
    },
    rawTokens: tokensOf(raw),
    returnedTokens: tokensOf(returned),
    savedTokens: tokensOf(raw - returned),
    savedPercent: raw ? Math.round(100 - (100 * returned) / raw) : 0,
    ...(() => {
      const pageHtml = Object.values(s.sites).reduce((n, c) => n + (c.pageHtmlChars ?? 0), 0);
      const pageText = Object.values(s.sites).reduce((n, c) => n + (c.pageTextChars ?? 0), 0);
      // Tool definitions kept out of context count as "sent" that the AI never had to take in.
      const allRaw = raw + pageHtml + definitionsSavedChars;
      const allReturned = returned + pageText;
      return {
        totalSavedTokens: tokensOf(allRaw - allReturned),
        totalPercent: allRaw ? Math.round(100 - (100 * allReturned) / allRaw) : 0,
      };
    })(),
    sites,
    mcp: {
      calls: mcpRows.reduce((n, x) => n + x.calls, 0),
      savedTokens: mcpRows.reduce((n, x) => n + x.savedTokens, 0),
      sessions: s.sessions ?? 0,
      definitionsSavedTokens: tokensOf(definitionsSavedChars),
      servers,
    },
    toolList: {
      toolCount,
      loadedTokens: tokensOf(listedChars),
      allToolsTokens: tokensOf(allChars),
      savedTokens: Math.max(0, tokensOf(allChars - listedChars)),
    },
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function statsSummary(st: UsageStats): string {
  const f = formatTokens;
  const anything = st.calls || st.pages.calls || st.mcp.definitionsSavedTokens;
  const lines = [
    anything
      ? `Estimated total: saved ≈ ${f(st.totalSavedTokens)} tokens (${st.totalPercent}%) since ${st.since.slice(0, 10)}.`
      : "Nothing measured yet.",
  ];
  const siteCalls = st.calls - st.mcp.calls;
  if (siteCalls) {
    const rows = st.sites.filter((x) => x.kind === "site");
    const saved = rows.reduce((n, x) => n + x.savedTokens, 0);
    lines.push(`- Website API calls: ${siteCalls}, saved ≈ ${f(saved)} (sites sent more than the AI needed).`);
  }
  if (st.pages.calls) {
    lines.push(`- Page reads: ${st.pages.calls}, the AI got ${f(st.pages.textTokens)} tokens of text instead of ${f(st.pages.htmlTokens)} of page HTML.`);
  }
  if (st.mcp.servers.length || st.mcp.calls) {
    lines.push(
      `- Other MCP servers: ${st.mcp.calls} call(s), responses trimmed by ≈ ${f(st.mcp.savedTokens)}; their tool definitions ` +
        `stayed out of ${st.mcp.sessions} AI session(s), ≈ ${f(st.mcp.definitionsSavedTokens)} tokens (at least: apps resend tool lists every turn).`,
    );
    for (const sv of st.mcp.servers) {
      lines.push(`    ${sv.name}: ${sv.toolCount} tools (≈ ${f(sv.definitionTokens)} tokens kept out of each conversation), ${sv.calls} call(s), saved ≈ ${f(sv.savedTokens)} on responses`);
    }
  }
  lines.push(
    `Tool list now: ${f(st.toolList.loadedTokens)} tokens of AnyMCP definitions in context, instead of ` +
      `${f(st.toolList.allToolsTokens)} for all ${st.toolList.toolCount} site and MCP server tools.`,
  );
  const top = st.sites.filter((x) => x.calls || x.pageCalls).slice(0, 10);
  if (top.length) lines.push("By site:");
  for (const s of top) {
    const parts = [];
    if (s.calls) parts.push(`${s.calls} call(s), saved ≈ ${f(s.savedTokens)} (${f(s.rawTokens)} → ${f(s.returnedTokens)})`);
    if (s.pageCalls) parts.push(`${s.pageCalls} page read(s), ${f(s.pageHtmlTokens)} HTML → ${f(s.pageTextTokens)} text`);
    lines.push(`  ${s.id}${s.kind === "mcp" ? " (MCP server)" : ""}: ${parts.join("; ")}`);
  }
  lines.push("Estimates use about 4 characters per token.");
  return lines.join("\n");
}
