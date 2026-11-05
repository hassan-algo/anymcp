import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.dirname(here);
export const require = createRequire(path.join(root, "package.json"));
export const distEntry = path.join(root, "dist/index.js");

let libPromise;
/** Bundles src/testing.ts once so tests can use the internal classes. */
export function loadLib() {
  libPromise ??= (async () => {
    const { build } = await import("esbuild");
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "anymcp-lib-")), "lib.mjs");
    await build({
      entryPoints: [path.join(root, "src/testing.ts")],
      outfile: out,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["bufferutil", "utf-8-validate"],
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
      logLevel: "error",
    });
    return import(out);
  })();
  return libPromise;
}

export async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export const sessionProfile = {
  schemaVersion: 1,
  id: "example.com",
  name: "Example",
  description: "Test profile that runs in the browser.",
  version: "1.0.0",
  authors: ["test"],
  categories: ["dev"],
  origins: ["https://example.com"],
  auth: "browser-session",
  allowedHosts: ["example.com", "api.example.com"],
  tools: [
    {
      name: "get_item",
      title: "Get item",
      description: "Fetch one item by id from the example API.",
      input: { type: "object", properties: { id: { type: "string" }, verbose: { type: "boolean" } }, required: ["id"] },
      mutates: false,
      action: {
        kind: "http",
        method: "GET",
        url: "https://api.example.com/items/{id}",
        query: { verbose: "{verbose}" },
        headers: { "x-csrf-token": "{$meta:csrf-token}" },
        response: { pick: "item", fields: ["name"] },
      },
    },
    {
      name: "create_item",
      title: "Create item",
      description: "Create a new item in the example API.",
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      mutates: true,
      action: { kind: "http", method: "POST", url: "https://api.example.com/items", body: { encoding: "json", value: { name: "{name}" } } },
    },
  ],
};

export const publicProfile = {
  schemaVersion: 1,
  id: "weather.test",
  name: "Weather Test",
  description: "Public weather search for tests.",
  version: "1.0.0",
  authors: ["test"],
  categories: ["travel"],
  origins: ["https://weather.test"],
  auth: "none",
  allowedHosts: ["api.weather.test"],
  tools: [
    {
      name: "forecast",
      title: "Weather forecast",
      description: "Get the weather forecast for a city.",
      input: { type: "object", properties: { city: { type: "string" }, days: { type: "integer" } }, required: ["city"] },
      mutates: false,
      action: {
        kind: "http",
        method: "GET",
        url: "https://api.weather.test/forecast",
        query: { q: "{city}", days: "{days}" },
        response: { pick: "daily", fields: ["day", "max"] },
      },
    },
  ],
};

/** Temp ANYMCP_HOME with a bundled index holding the public profile and a list. */
export async function makeHome({ localProfiles = [sessionProfile] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "anymcp-home-"));
  const port = await freePort();
  const token = "t".repeat(48);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ token, port }));
  fs.mkdirSync(path.join(home, "profiles"));
  for (const p of localProfiles) fs.writeFileSync(path.join(home, "profiles", `${p.id}.json`), JSON.stringify(p));
  const bundled = path.join(home, "bundled-index.json");
  fs.writeFileSync(
    bundled,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      categories: [
        { id: "dev", name: "Developer", description: "" },
        { id: "travel", name: "Travel", description: "" },
      ],
      lists: [{ schemaVersion: 1, id: "starter", name: "Starter", description: "A starter list of sites.", authors: ["t"], profiles: ["weather.test"] }],
      profiles: [publicProfile, { id: "broken" }],
    }),
  );
  // Never read the real AI apps' settings in tests.
  const appsHome = path.join(home, "apps-home");
  fs.mkdirSync(appsHome, { recursive: true });
  const env = { ...process.env, ANYMCP_HOME: home, ANYMCP_BUNDLED_INDEX: bundled, ANYMCP_APPS_HOME: appsHome, ANYMCP_REGISTRY_URL: "" };
  delete env.ANYMCP_PORT;
  return { home, port, token, bundled, env, appsHome };
}

/** A fake browser extension. `handlers[method](params)` answers gateway requests. */
export async function fakeExtension({ port, token, handlers, origin = "chrome-extension://test" }) {
  const WebSocket = require("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  const calls = [];
  let nextId = 1;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, role: "extension", version: "test" })));
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") return resolve();
      if (msg.type === "response") {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.result);
        else p?.reject(new Error(msg.error));
        return;
      }
      if (msg.type !== "request") return;
      calls.push({ method: msg.method, params: msg.params });
      try {
        const h = handlers[msg.method];
        if (!h) throw new Error(`no handler for ${msg.method}`);
        ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: await h(msg.params) }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: err.message }));
      }
    });
  });
  return {
    ws,
    calls,
    /** Calls a GatewayMethods method, like the side panel does. */
    request(method, params) {
      const id = nextId++;
      ws.send(JSON.stringify({ type: "request", id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}

export async function startGateway(env) {
  const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
  const { StdioClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [distEntry], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

export async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const text = (result) => result.content.map((c) => c.text ?? "").join("\n");
