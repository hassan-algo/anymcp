// Finds the MCP servers configured in the user's AI apps, so AnyMCP can offer to run them itself
// (their tool definitions then stay out of every conversation).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic, type Paths } from "./config.js";
import type { ServerConfig, Upstream } from "./upstream.js";

export interface FoundServer {
  app: string;
  file: string;
  /** The name in the app's config. */
  rawName: string;
  /** The name AnyMCP will use. */
  name: string;
  cfg: ServerConfig;
}

/** ANYMCP_APPS_HOME points discovery somewhere else (tests). */
export function appConfigs(home = process.env.ANYMCP_APPS_HOME ?? os.homedir()): Record<string, string> {
  return {
    "Claude Code": path.join(home, ".claude.json"),
    "Claude Desktop": path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    Cursor: path.join(home, ".cursor", "mcp.json"),
  };
}

/** Is this entry AnyMCP itself? (Importing it would loop.) */
export function isAnyMcp(name: string, cfg: { command?: string; args?: string[] }): boolean {
  if (/^anymcp$/i.test(name)) return true;
  const all = [cfg.command ?? "", ...(cfg.args ?? [])].join(" ");
  return /(^|[\s/@])anymcp-gateway(@[\w.-]+)?(\s|$)|[\\/]gateway[\\/]dist[\\/]index\.js(\s|$)/i.test(all);
}

function toConfig(entry: Record<string, unknown>): ServerConfig {
  const cfg: ServerConfig =
    typeof entry.url === "string"
      ? { url: entry.url, headers: (entry.headers as Record<string, string>) ?? {} }
      : { command: entry.command as string, args: (entry.args as string[]) ?? [], env: (entry.env as Record<string, string>) ?? {} };
  if (entry.type === "sse") cfg.transport = "sse";
  return cfg;
}

const same = (a: ServerConfig, b: ServerConfig) =>
  a.url ? a.url === b.url : a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);

/** Servers in the user's apps that AnyMCP doesn't run yet. */
export function discoverAppServers(up: Upstream, home?: string): FoundServer[] {
  const have = up.servers();
  const found: FoundServer[] = [];
  const taken = new Set(Object.keys(have));
  for (const [app, file] of Object.entries(appConfigs(home))) {
    let data: { mcpServers?: Record<string, Record<string, unknown>> };
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const [rawName, entry] of Object.entries(data.mcpServers ?? {})) {
      if (!entry || typeof entry !== "object" || (!entry.command && !entry.url)) continue;
      const cfg = toConfig(entry);
      if (isAnyMcp(rawName, cfg)) continue;
      if (Object.values(have).some((c) => same(c, cfg)) || found.some((f) => same(f.cfg, cfg))) continue;
      let name = rawName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 40) || "server";
      for (let i = 2; taken.has(name); i++) name = `${name.replace(/-\d+$/, "")}-${i}`;
      taken.add(name);
      found.push({ app, file, rawName, name, cfg });
    }
  }
  return found;
}

export function importServers(up: Upstream, found: FoundServer[]): string[] {
  const added: string[] = [];
  for (const f of found) {
    try {
      up.add(f.name, f.cfg);
      added.push(f.name);
    } catch {
      // a config AnyMCP can't run; leave it in the app
    }
  }
  return added;
}

/** Removes imported servers from the apps' configs (after a backup), so they aren't loaded twice. */
export function removeFromApps(found: FoundServer[]): string[] {
  const changed: string[] = [];
  for (const file of new Set(found.map((f) => f.file))) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const data = JSON.parse(text);
      for (const f of found.filter((x) => x.file === file)) delete data.mcpServers?.[f.rawName];
      fs.writeFileSync(`${file}.anymcp-backup`, text, { mode: 0o600 });
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
      changed.push(file);
    } catch {
      // leave that app alone
    }
  }
  return changed;
}

// ---- Remembering the answer ----

interface PromptState {
  never?: boolean;
  /** Servers the user said "Not now" to, and when. */
  later?: Record<string, string>;
}

const LATER_MS = 7 * 24 * 60 * 60 * 1000;
const key = (f: FoundServer) => `${f.app}:${f.rawName}:${f.cfg.url ?? [f.cfg.command, ...(f.cfg.args ?? [])].join(" ")}`;

function stateFile(paths: Paths): string {
  return path.join(paths.home, "import-prompt.json");
}

function readState(paths: Paths): PromptState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(paths), "utf8"));
  } catch {
    return {};
  }
}

/** Found servers the user hasn't already declined (empty if they said "Don't ask again"). */
export function worthAsking(paths: Paths, found: FoundServer[], now = Date.now()): FoundServer[] {
  const s = readState(paths);
  if (s.never) return [];
  return found.filter((f) => !s.later?.[key(f)] || now - Date.parse(s.later[key(f)]!) > LATER_MS);
}

export function rememberAnswer(paths: Paths, found: FoundServer[], answer: "later" | "never"): void {
  const s = readState(paths);
  if (answer === "never") s.never = true;
  else {
    s.later ??= {};
    for (const f of found) s.later[key(f)] = new Date().toISOString();
  }
  writeFileAtomic(stateFile(paths), JSON.stringify(s, null, 2) + "\n");
}
