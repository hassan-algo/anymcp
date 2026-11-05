// Local WebSocket link to the browser extension.
//
// The first gateway process to start owns the port (leader). The extension connects to it.
// Gateways started later (other AI clients) connect to the leader as peers (followers) and
// forward browser calls through it. If the leader exits, a follower takes over the port.

import { timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  CLOSE_AUTH_FAILED,
  TRUSTED_EXTENSION_IDS,
  type ClientToGateway,
  type ExtensionMethods,
  type GatewayToClient,
  type Hello,
  type MethodName,
  type RpcRequest,
  type RpcResponse,
} from "@anymcp/shared";

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

const NOT_CONNECTED =
  "The AnyMCP browser extension is not connected. Open Chrome with the AnyMCP extension installed, " +
  "and paste the pairing token (run `npx -y anymcp-gateway token`) into its side panel.";

/** Request/response over one WebSocket, in both directions. */
class RpcLink {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    readonly ws: WebSocket,
    private readonly onRequest: RequestHandler,
  ) {}

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser didn't answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      send(this.ws, { type: "request", id, method, params });
    });
  }

  /** Handles a parsed message. Returns false if it wasn't an RPC message. */
  handle(msg: RpcRequest | RpcResponse | { type: string }): boolean {
    if (msg.type === "response") {
      const r = msg as RpcResponse;
      const p = this.pending.get(r.id);
      if (!p) return true;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      if (r.ok) p.resolve(r.result);
      else p.reject(new Error(r.error));
      return true;
    }
    if (msg.type === "request") {
      const r = msg as RpcRequest;
      this.onRequest(r.method, r.params).then(
        (result) => send(this.ws, { type: "response", id: r.id, ok: true, result }),
        (err: unknown) =>
          send(this.ws, { type: "response", id: r.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return true;
    }
    return false;
  }

  failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

function send(ws: WebSocket, msg: GatewayToClient | ClientToGateway): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function parse(raw: WebSocket.RawData): any {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return undefined;
  }
}

export interface BridgeOptions {
  port: number;
  token: string;
  version: string;
  log: (msg: string) => void;
  /** Answers GatewayMethods requests from the extension (side panel). */
  handleGatewayMethod: RequestHandler;
  /** When this gateway was built; see version.ts. */
  build?: number;
  /** Called when the extension connects or disconnects (leader only). */
  onExtensionChange?: (connected: boolean) => void;
  /** Leader: answers other gateways' requests (besides browser forwarding). `peer` can ask back. */
  handlePeerRequest?: (method: string, params: unknown, peer: { request(method: string, params: unknown, timeoutMs: number): Promise<unknown> }) => Promise<unknown>;
  /** Follower: answers requests the leader sends back (e.g. a server's question during our call). */
  handleLeaderRequest?: RequestHandler;
  /** This gateway became the leader, or stopped being it. */
  onRoleChange?: (role: "leader" | "follower") => void;
}

export class Bridge {
  role: "starting" | "leader" | "follower" = "starting";
  private wss: WebSocketServer | null = null;
  private extension: RpcLink | null = null;
  private peers = new Set<RpcLink>();
  private leaderLink: RpcLink | null = null;
  private retryTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly opts: BridgeOptions) {}

  /** True if browser calls can currently be sent somewhere. */
  get connected(): boolean {
    return this.role === "leader" ? this.extension !== null : this.leaderLink !== null;
  }

  async start(): Promise<void> {
    try {
      await this.listen();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      this.opts.log(`Port ${this.opts.port} is in use; joining the AnyMCP gateway that's already running.`);
      this.follow();
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.wss?.close();
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.leaderLink?.ws.close();
  }

  call<M extends MethodName>(
    method: M,
    params: ExtensionMethods[M]["params"],
    timeoutMs = 30_000,
  ): Promise<ExtensionMethods[M]["result"]> {
    if (this.role === "leader") {
      if (!this.extension) return Promise.reject(new Error(NOT_CONNECTED));
      return this.extension.request(method, params, timeoutMs) as Promise<ExtensionMethods[M]["result"]>;
    }
    if (!this.leaderLink) return Promise.reject(new Error(NOT_CONNECTED));
    return this.leaderLink.request("forward", { method, params, timeoutMs }, timeoutMs + 5_000) as Promise<
      ExtensionMethods[M]["result"]
    >;
  }

  // ---- Leader ----

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.opts.port,
        // Web pages can open WebSockets to localhost too. Browsers always send Origin, so only
        // extension origins are allowed; local processes (peer gateways) send none.
        verifyClient: ({ origin }: { origin?: string }) => !origin || origin.startsWith("chrome-extension://"),
      });
      const onError = (err: Error) => {
        wss.close();
        reject(err);
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        wss.on("error", (err) => this.opts.log(`WebSocket server error: ${err.message}`));
        this.wss = wss;
        this.role = "leader";
        this.opts.onRoleChange?.("leader");
        resolve();
      });
      wss.on("connection", (ws, req) => this.onConnection(ws, req.headers.origin));
    });
  }

  private onConnection(ws: WebSocket, origin: string | undefined): void {
    let link: RpcLink | null = null;
    let kind: "extension" | "peer" | null = null;
    const authTimer = setTimeout(() => ws.close(CLOSE_AUTH_FAILED, "no hello"), 5_000);

    ws.on("message", (raw) => {
      const msg = parse(raw);
      if (!msg || typeof msg.type !== "string") return;

      if (!link) {
        const hello = msg as Partial<Hello>;
        // The official extension is recognised by its ID; anything else needs the pairing token.
        const trusted = hello.role !== "peer" && typeof origin === "string" && this.trustedOrigins.has(origin);
        if (hello.type !== "hello" || (!trusted && !this.tokenMatches(hello.token))) {
          this.opts.log("Rejected a connection: not the AnyMCP extension, and no valid pairing token.");
          ws.close(CLOSE_AUTH_FAILED, "bad token");
          return;
        }
        clearTimeout(authTimer);
        // Browsers always send an Origin, so a peer claim from a browser is refused.
        kind = hello.role === "peer" && !origin ? "peer" : "extension";
        if (kind === "extension") {
          const old = this.extension;
          link = new RpcLink(ws, (m, p) => this.opts.handleGatewayMethod(m, p));
          this.extension = link;
          old?.ws.close(1000, "replaced by a newer connection");
          this.opts.log(`Browser extension connected (v${hello.version ?? (msg as { extensionVersion?: string }).extensionVersion ?? "?"}).`);
          this.opts.onExtensionChange?.(true);
        } else {
          const peer: RpcLink = new RpcLink(ws, (m, p) => this.handlePeerRequest(m, p, peer));
          link = peer;
          this.peers.add(link);
          // A gateway with newer code joined: hand it the port so the extension gets the new code.
          if ((hello.build ?? 0) > (this.opts.build ?? 0)) {
            send(ws, { type: "welcome", gatewayVersion: this.opts.version });
            this.stepDown();
            return;
          }
        }
        send(ws, { type: "welcome", gatewayVersion: this.opts.version });
        return;
      }

      if (msg.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }
      link.handle(msg);
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (!link) return;
      if (kind === "extension" && this.extension === link) {
        this.extension = null;
        link.failAll("The browser extension disconnected before answering.");
        this.opts.log("Browser extension disconnected.");
        this.opts.onExtensionChange?.(false);
      } else if (kind === "peer") {
        this.peers.delete(link);
        link.failAll("Peer disconnected.");
      }
    });
    ws.on("error", () => undefined);
  }

  /** Follower: sends a request to the leader gateway. */
  callLeader(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.role !== "follower" || !this.leaderLink) return Promise.reject(new Error("Not connected to the main AnyMCP gateway."));
    return this.leaderLink.request(method, params, timeoutMs);
  }

  private async handlePeerRequest(method: string, params: unknown, link?: RpcLink): Promise<unknown> {
    if (method !== "forward") {
      if (!this.opts.handlePeerRequest || !link) throw new Error(`Unknown method "${method}"`);
      return this.opts.handlePeerRequest(method, params, link);
    }
    const p = params as { method: MethodName; params: unknown; timeoutMs?: number };
    if (!this.extension) throw new Error(NOT_CONNECTED);
    return this.extension.request(p.method, p.params, p.timeoutMs ?? 30_000);
  }

  private readonly trustedOrigins = new Set(
    [...TRUSTED_EXTENSION_IDS, ...(process.env.ANYMCP_EXTENSION_IDS ?? "").split(",").filter(Boolean)].map((id) => `chrome-extension://${id.trim()}`),
  );

  private tokenMatches(candidate: unknown): boolean {
    if (typeof candidate !== "string") return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Gives up the port to a newer gateway, then joins it. */
  private stepDown(): void {
    if (this.role !== "leader") return;
    this.opts.log("A newer AnyMCP gateway started; handing over to it.");
    const wss = this.wss;
    this.wss = null;
    this.extension = null;
    this.role = "follower";
    this.opts.onRoleChange?.("follower");
    for (const c of wss?.clients ?? []) c.terminate();
    wss?.close();
    this.opts.onExtensionChange?.(false);
    // Wait so the newer gateway (which retries every 3s) gets the port first.
    this.retryTimer = setTimeout(() => this.follow(), 5_000);
  }

  // ---- Follower ----

  private follow(): void {
    if (this.closed) return;
    this.role = "follower";
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}`);
    let link: RpcLink | null = null;

    ws.on("open", () => send(ws, { type: "hello", token: this.opts.token, role: "peer", version: this.opts.version, build: this.opts.build }));
    ws.on("message", (raw) => {
      const msg = parse(raw);
      if (!msg) return;
      if (msg.type === "welcome") {
        link = new RpcLink(ws, async (m, p) => {
          if (this.opts.handleLeaderRequest) return this.opts.handleLeaderRequest(m, p);
          throw new Error(`Unknown method "${m}"`);
        });
        this.leaderLink = link;
        return;
      }
      link?.handle(msg);
    });
    ws.on("error", () => undefined);
    ws.on("close", (code) => {
      if (this.leaderLink === link) this.leaderLink = null;
      link?.failAll("Lost the connection to the main AnyMCP gateway.");
      if (this.closed) return;
      if (code === CLOSE_AUTH_FAILED) this.opts.log("The running gateway refused our pairing token (different ANYMCP_HOME?).");
      this.retryTimer = setTimeout(() => void this.takeOver(), 3_000);
    });
  }

  private async takeOver(): Promise<void> {
    if (this.closed) return;
    try {
      await this.listen();
      this.opts.log("Took over the gateway port; waiting for the browser extension.");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") this.follow();
      else {
        this.opts.log(`Could not take over the port: ${(err as Error).message}`);
        this.retryTimer = setTimeout(() => void this.takeOver(), 3_000);
      }
    }
  }
}
