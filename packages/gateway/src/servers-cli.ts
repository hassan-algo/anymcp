// `anymcp server …`: connect other MCP servers through AnyMCP.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPaths } from "./config.js";
import { tokensOf } from "./stats.js";
import { DEFAULT_SAMPLING_MODEL } from "./sampling.js";
import { Upstream, type ServerConfig } from "./upstream.js";

export const SERVER_HELP = `  anymcp server list         MCP servers connected through AnyMCP
  anymcp server add <name> [--env K=V]… -- <command> [args…]
  anymcp server add <name> --url <https://…> [--header K=V]… [--transport sse]
                             Run another MCP server behind AnyMCP: its tools stay out of your AI's context
  anymcp server import [claude-code|claude-desktop|cursor]
                             Copy the MCP servers configured in that app
  anymcp server test <name>  Start it, list its tools, show the tokens kept out of context
  anymcp server remove <name>
  anymcp server sampling on|off [--model <id>] [--api-key <key>]
                             When a server asks for text generation and your AI app can't do it,
                             call the Claude API with your key (off by default; costs API usage)`;

/** Where each app keeps its MCP server list. */
const APP_CONFIGS: Record<string, string> = {
  "claude-code": path.join(os.homedir(), ".claude.json"),
  "claude-desktop": path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  cursor: path.join(os.homedir(), ".cursor", "mcp.json"),
};

function pairs(list: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i] !== flag) continue;
    const kv = list[i + 1] ?? "";
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

/** Is this entry AnyMCP itself? (Importing it would loop.) */
function isAnyMcp(name: string, cfg: { command?: string; args?: string[] }): boolean {
  if (/^anymcp$/i.test(name)) return true;
  const all = [cfg.command ?? "", ...(cfg.args ?? [])].join(" ");
  // The npm package, or a local build of this gateway.
  return /(^|[\s/@])anymcp-gateway(@[\w.-]+)?(\s|$)|[\\/]gateway[\\/]dist[\\/]index\.js(\s|$)/i.test(all);
}

export async function serverCommand(argv: string[]): Promise<void> {
  const [sub, name, ...rest] = argv;
  const up = new Upstream(getPaths(), (m) => console.error(m));
  switch (sub) {
    case undefined:
    case "list": {
      const all = Object.entries(up.servers());
      if (!all.length) {
        console.log("No MCP servers yet. Add one with `anymcp server add`, or `anymcp server import claude-code`.");
        return;
      }
      const profiles = new Map(up.profiles().map((p) => [p.id.replace(/^mcp-/, ""), p]));
      for (const [n, c] of all) {
        const tools = profiles.get(n)?.tools.length;
        const how = c.url ? c.url : [c.command, ...(c.args ?? [])].join(" ");
        console.log(`${n.padEnd(20)} ${tools === undefined ? "not started yet" : `${tools} tools`}${c.disabled ? " (disabled)" : ""}  ${how}`);
      }
      return;
    }
    case "add": {
      if (!name) throw new Error("Usage: anymcp server add <name> -- <command> [args…]   or   --url <url>");
      const dash = rest.indexOf("--");
      const flags = dash >= 0 ? rest.slice(0, dash) : rest;
      const cmd = dash >= 0 ? rest.slice(dash + 1) : [];
      const urlAt = flags.indexOf("--url");
      const tIdx = flags.indexOf("--transport");
      const transport = tIdx >= 0 ? (flags[tIdx + 1] as ServerConfig["transport"]) : undefined;
      const cfg: ServerConfig =
        urlAt >= 0
          ? { url: flags[urlAt + 1], headers: pairs(flags, "--header"), ...(transport ? { transport } : {}) }
          : { command: cmd[0], args: cmd.slice(1), env: pairs(flags, "--env") };
      up.add(name, cfg);
      console.log(`Added "${name}". Its tools appear in your AI's search_tools once it has started (run \`anymcp server test ${name}\` to start it now).`);
      return;
    }
    case "remove":
      if (!name || !up.remove(name)) throw new Error(`No MCP server "${name ?? ""}".`);
      console.log(`Removed "${name}".`);
      return;
    case "test": {
      if (!name) throw new Error("Usage: anymcp server test <name>");
      const count = await up.refresh(name);
      const p = up.profiles().find((x) => x.id === `mcp-${name}`);
      const chars = JSON.stringify(p?.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })) ?? []).length;
      console.log(`"${name}" works: ${count} tool(s). That's about ${tokensOf(chars).toLocaleString()} tokens of tool definitions now kept out of your AI's context.`);
      await up.closeAll();
      return;
    }
    case "import": {
      const app = name ?? "claude-code";
      const file = APP_CONFIGS[app];
      if (!file) throw new Error(`Unknown app "${app}". Use claude-code, claude-desktop or cursor.`);
      let data: { mcpServers?: Record<string, Record<string, unknown>> };
      try {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw new Error(`Couldn't read ${file}.`);
      }
      const added: string[] = [];
      const skipped: string[] = [];
      for (const [raw, entry] of Object.entries(data.mcpServers ?? {})) {
        const n = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 40) || "server";
        const cfg: ServerConfig =
          typeof entry.url === "string"
            ? { url: entry.url, headers: (entry.headers as Record<string, string>) ?? {} }
            : { command: entry.command as string, args: (entry.args as string[]) ?? [], env: (entry.env as Record<string, string>) ?? {} };
        if (isAnyMcp(raw, cfg)) continue;
        if (entry.type === "sse") cfg.transport = "sse";
        try {
          up.add(n, cfg);
          added.push(n);
        } catch (err) {
          skipped.push(`${raw} (${(err as Error).message})`);
        }
      }
      if (!added.length && !skipped.length) {
        console.log(`No MCP servers to import from ${app} (only user-level servers are read: ${file}).`);
        return;
      }
      if (added.length) {
        console.log(`Imported ${added.length}: ${added.join(", ")}.`);
        console.log(`Now remove them from ${app}, so their tools aren't loaded into your AI twice. AnyMCP will serve them.`);
      }
      if (skipped.length) console.log(`Skipped: ${skipped.join("; ")}.`);
      return;
    }
    case "sampling": {
      const flag = (f: string) => {
        const i = rest.indexOf(f);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const current = up.sampling();
      if (name === "on" || name === "off") {
        const next = { ...current, enabled: name === "on" };
        const model = flag("--model");
        const apiKey = flag("--api-key");
        if (model) next.model = model;
        if (apiKey) next.apiKey = apiKey;
        up.setSampling(next);
      } else if (name !== undefined && name !== "status") {
        throw new Error("Usage: anymcp server sampling on|off [--model <id>] [--api-key <key>]");
      }
      const s = up.sampling();
      console.log(
        s.enabled
          ? `Sampling fallback is on: servers' text requests go to ${s.model ?? DEFAULT_SAMPLING_MODEL} with ${s.apiKey ? "the saved API key" : "your Anthropic credentials (ANTHROPIC_API_KEY or `ant auth login`)"} when your AI app can't answer them.`
          : "Sampling fallback is off: servers' text requests only work if your AI app supports them.",
      );
      return;
    }
    default:
      throw new Error(`Unknown command "server ${sub}".\n\n${SERVER_HELP}`);
  }
}
