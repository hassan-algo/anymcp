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
    for (const t of entry.profile.tools) {
      toolCount++;
      allChars += JSON.stringify({ name: pinnedToolName(entry.profile.id, t.name), description: t.description, inputSchema: t.input }).length;
    }
  }

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
      const allRaw = raw + pageHtml;
      const allReturned = returned + pageText;
      return {
        totalSavedTokens: tokensOf(allRaw - allReturned),
        totalPercent: allRaw ? Math.round(100 - (100 * allReturned) / allRaw) : 0,
      };
    })(),
    sites,
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
  const lines = [
    st.calls || st.pages.calls
      ? `Estimated total: saved ≈ ${formatTokens(st.totalSavedTokens)} tokens (${st.totalPercent}%) across ${st.calls} API call(s) and ${st.pages.calls} page read(s).`
      : "Nothing measured yet.",
    st.calls
      ? `Saved ≈ ${formatTokens(st.savedTokens)} tokens (${st.savedPercent}%) across ${st.calls} call(s) since ${st.since.slice(0, 10)}: ` +
        `sites sent ${formatTokens(st.rawTokens)}, the AI received ${formatTokens(st.returnedTokens)}.`
      : "No site tool calls recorded yet.",
    `Tool list: the AI keeps ${formatTokens(st.toolList.loadedTokens)} tokens of AnyMCP tool definitions in context, instead of ` +
      `${formatTokens(st.toolList.allToolsTokens)} for all ${st.toolList.toolCount} site and MCP server tools (this gap grows with every site or server added).`,
  ];
  if (st.pages.calls) {
    lines.push(
      `Page reads: ${st.pages.calls} page(s), the AI got ${formatTokens(st.pages.textTokens)} tokens of text instead of ` +
        `${formatTokens(st.pages.htmlTokens)} of page HTML (not counted above: reading the page yourself gives the same text).`,
    );
  }
  for (const s of st.sites.filter((x) => x.calls || x.pageCalls).slice(0, 10)) {
    const parts = [];
    if (s.calls) parts.push(`${s.calls} API call(s), saved ≈ ${formatTokens(s.savedTokens)} (${formatTokens(s.rawTokens)} → ${formatTokens(s.returnedTokens)})`);
    if (s.pageCalls) parts.push(`${s.pageCalls} page read(s), ${formatTokens(s.pageHtmlTokens)} HTML → ${formatTokens(s.pageTextTokens)} text`);
    lines.push(`  ${s.id}: ${parts.join("; ")}`);
  }
  lines.push("Estimates use about 4 characters per token.");
  return lines.join("\n");
}
