// Other MCP servers the user connects through AnyMCP. Their tools go into the catalog (search,
// describe, call) instead of the AI's context, and their results are compacted.
//
// ~/.anymcp/servers.json            which servers to run (may hold API keys: mode 0600)
// ~/.anymcp/cache/servers/<n>.json  their last tool list, so search works before they start
//
// A server is started the first time one of its tools is called (or to refresh its tool list).

import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { SamplingSettings } from "./sampling.js";
import { snake, uniqueName, type Profile, type Tool } from "@anymcp/shared";
import { writeFileAtomic, type Paths } from "./config.js";
import { VERSION } from "./version.js";

export interface ServerConfig {
  /** Run a local command (stdio). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Or connect to a remote server: Streamable HTTP, falling back to the older SSE transport. */
  url?: string;
  headers?: Record<string, string>;
  /** Force one transport for a url server. */
  transport?: "streamable-http" | "sse";
  /** Cap on each result's text. Default 25000 characters. */
  maxChars?: number;
  disabled?: boolean;
}

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
  title?: string;
}

interface Cache {
  at: string;
  instructions?: string;
  tools: CachedTool[];
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const WRITE_VERBS = /^(create|update|delete|remove|send|post|write|push|merge|close|add|set|edit|move|rename|upload|publish|comment|approve|reject|cancel|archive|fork|transfer|invite|assign|execute|run|deploy|insert|drop|modify|patch|put|reply|mark)/i;

/**
 * Who answers a server's questions (elicitation) and text-generation requests (sampling) during
 * a call: the AI session that made the call.
 */
export interface CallOwner {
  elicit(params: ElicitRequest["params"]): Promise<ElicitResult>;
  sample(params: CreateMessageRequest["params"]): Promise<CreateMessageResult>;
}

export function serverProfileId(name: string): string {
  return `mcp-${name}`;
}

export class Upstream {
  private clients = new Map<string, Promise<Client>>();
  /** Calls running on each server, newest last: their owners answer the server's requests. */
  private inflight = new Map<string, CallOwner[]>();

  constructor(
    private readonly paths: Paths,
    private readonly log: (m: string) => void,
    /** Called when a server's tool list changes. */
    private readonly onChange: () => void = () => {},
    /** Answers requests that arrive when no call is running (e.g. while listing tools). */
    private readonly defaultOwner?: () => CallOwner,
  ) {}

  private ownerFor(name: string): CallOwner {
    const list = this.inflight.get(name);
    const owner = list?.[list.length - 1] ?? this.defaultOwner?.();
    if (!owner) throw new Error("Nobody can answer this server's request right now.");
    return owner;
  }

  private get file(): string {
    return path.join(this.paths.home, "servers.json");
  }

  private cacheFile(name: string): string {
    return path.join(this.paths.cacheDir, "servers", `${name}.json`);
  }

  private read(): { servers: Record<string, ServerConfig>; sampling?: SamplingSettings } {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { servers: v && typeof v.servers === "object" ? v.servers : {}, sampling: v?.sampling };
    } catch {
      return { servers: {} };
    }
  }

  servers(): Record<string, ServerConfig> {
    return this.read().servers;
  }

  private save(servers: Record<string, ServerConfig>): void {
    writeFileAtomic(this.file, JSON.stringify({ ...this.read(), servers }, null, 2) + "\n");
  }

  sampling(): SamplingSettings {
    return this.read().sampling ?? {};
  }

  setSampling(s: SamplingSettings): void {
    writeFileAtomic(this.file, JSON.stringify({ ...this.read(), sampling: s }, null, 2) + "\n");
  }

  /** Changes when servers.json or any cached tool list changes. */
  stamp(): string {
    const files = [this.file];
    try {
      for (const f of fs.readdirSync(path.join(this.paths.cacheDir, "servers"))) files.push(path.join(this.paths.cacheDir, "servers", f));
    } catch {
      // none yet
    }
    return files.map((f) => `${f}:${fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0}`).join("|");
  }

  add(name: string, cfg: ServerConfig): void {
    if (!NAME.test(name)) throw new Error(`Server names use lowercase letters, digits, - and _ (got "${name}").`);
    if (!cfg.command && !cfg.url) throw new Error("Give a command to run, or --url for a remote server.");
    if (cfg.url && !/^https?:\/\//.test(cfg.url)) throw new Error(`"${cfg.url}" isn't an http(s) address.`);
    this.save({ ...this.servers(), [name]: cfg });
  }

  remove(name: string): boolean {
    const all = this.servers();
    if (!(name in all)) return false;
    delete all[name];
    this.save(all);
    fs.rmSync(this.cacheFile(name), { force: true });
    void this.disconnect(name);
    return true;
  }

  private readCache(name: string): Cache | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile(name), "utf8"));
    } catch {
      return undefined;
    }
  }

  /** Catalog entries for every enabled server, from its cached tool list. */
  profiles(): Profile[] {
    const out: Profile[] = [];
    for (const [name, cfg] of Object.entries(this.servers())) {
      if (cfg.disabled) continue;
      const cache = this.readCache(name);
      if (cache) out.push(toProfile(name, cfg, cache));
    }
    return out;
  }

  /** Servers whose tool list was never fetched. */
  uncached(): string[] {
    return Object.entries(this.servers())
      .filter(([n, c]) => !c.disabled && !this.readCache(n))
      .map(([n]) => n);
  }

  private connect(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const cfg = this.servers()[name];
    if (!cfg) return Promise.reject(new Error(`No MCP server called "${name}". Run \`anymcp server list\`.`));
    const p = (async () => {
      const make = () => {
        // Tell servers we can answer their questions and text-generation requests.
        const c = new Client({ name: "anymcp", version: VERSION }, { capabilities: { elicitation: {}, sampling: {} } });
        c.setRequestHandler(ElicitRequestSchema, (req) => this.ownerFor(name).elicit(req.params));
        c.setRequestHandler(CreateMessageRequestSchema, (req) => this.ownerFor(name).sample(req.params));
        c.onclose = () => {
          if (this.clients.get(name) === p) this.clients.delete(name);
        };
        return c;
      };
      const timeoutMsg = `Starting the "${name}" MCP server took too long.`;
      let client = make();
      if (!cfg.url) {
        const stdio = new StdioClientTransport({
          command: cfg.command!,
          args: cfg.args ?? [],
          env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
          cwd: cfg.cwd,
          stderr: "ignore",
        });
        await withTimeout(client.connect(stdio), 60_000, timeoutMsg);
      } else {
        const url = new URL(cfg.url);
        const requestInit = { headers: cfg.headers ?? {} };
        const sse = () => new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...requestInit.headers } }) } });
        if (cfg.transport === "sse") {
          await withTimeout(client.connect(sse()), 60_000, timeoutMsg);
        } else {
          try {
            await withTimeout(client.connect(new StreamableHTTPClientTransport(url, { requestInit })), 60_000, timeoutMsg);
          } catch (err) {
            if (cfg.transport === "streamable-http") throw err;
            // Older servers only speak SSE: try that, as the MCP spec suggests.
            this.log(`"${name}": Streamable HTTP failed (${(err as Error).message}); trying the older SSE transport.`);
            await client.close().catch(() => undefined);
            client = make();
            await withTimeout(client.connect(sse()), 60_000, timeoutMsg);
          }
        }
      }
      await this.refreshTools(name, client);
      return client;
    })();
    p.catch(() => this.clients.delete(name));
    this.clients.set(name, p);
    return p;
  }

  private async refreshTools(name: string, client: Client): Promise<void> {
    const tools: CachedTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of r.tools) {
        tools.push({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
          annotations: t.annotations as CachedTool["annotations"],
        });
      }
      cursor = r.nextCursor;
    } while (cursor && tools.length < 2000);
    const before = JSON.stringify(this.readCache(name)?.tools ?? null);
    const cache: Cache = { at: new Date().toISOString(), instructions: client.getInstructions()?.slice(0, 1000), tools };
    fs.mkdirSync(path.dirname(this.cacheFile(name)), { recursive: true });
    writeFileAtomic(this.cacheFile(name), JSON.stringify(cache, null, 2) + "\n");
    if (JSON.stringify(tools) !== before) {
      this.log(`MCP server "${name}": ${tools.length} tool(s).`);
      this.onChange();
    }
  }

  /** Starts a server (if needed) to fetch its tool list. */
  async refresh(name: string): Promise<number> {
    const client = await this.connect(name);
    await this.refreshTools(name, client);
    return this.readCache(name)?.tools.length ?? 0;
  }

  async call(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    owner?: CallOwner,
  ): Promise<{ content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown }> {
    const client = await this.connect(name);
    const list = this.inflight.get(name) ?? [];
    const me = owner ?? this.defaultOwner?.();
    if (me) list.push(me);
    this.inflight.set(name, list);
    let r;
    try {
      r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000, resetTimeoutOnProgress: true });
    } finally {
      if (me) list.splice(list.lastIndexOf(me), 1);
    }
    const content = Array.isArray(r.content) ? (r.content as { type: string; text?: string }[]) : [];
    // Servers that only send structured results still need text for the AI.
    if (!content.length && r.structuredContent !== undefined) content.push({ type: "text", text: JSON.stringify(r.structuredContent) });
    return { content, isError: Boolean(r.isError) };
  }

  async disconnect(name: string): Promise<void> {
    const p = this.clients.get(name);
    this.clients.delete(name);
    const c = await p?.catch(() => undefined);
    await c?.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((n) => this.disconnect(n)));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

function toProfile(name: string, cfg: ServerConfig, cache: Cache): Profile {
  const names = new Set<string>();
  const tools: Tool[] = cache.tools.map((t) => {
    const a = t.annotations ?? {};
    const mutates = a.destructiveHint === true || (a.readOnlyHint !== true && WRITE_VERBS.test(snake(t.name)));
    const schema = t.inputSchema && t.inputSchema.type === "object" ? t.inputSchema : { type: "object", properties: {} };
    let description = (t.description ?? "").trim() || `The ${t.name} tool of the ${name} MCP server.`;
    if (description.length < 10) description = `${description} (${name} MCP server)`;
    return {
      name: uniqueName(t.name, names),
      title: t.title ?? a.title ?? t.name,
      description,
      input: { properties: {}, ...schema, type: "object" } as Tool["input"],
      mutates,
      action: { kind: "mcp", server: name, tool: t.name, ...(cfg.maxChars ? { maxChars: cfg.maxChars } : {}) },
    };
  });
  return {
    schemaVersion: 1,
    id: serverProfileId(name),
    name: `${name} (MCP server)`,
    description: cache.instructions?.trim() || `Tools from the ${name} MCP server, connected through AnyMCP.`,
    version: "0.0.0",
    authors: ["you"],
    categories: ["mcp"],
    origins: [],
    auth: "none",
    allowedHosts: [],
    tools,
  };
}
