import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { distEntry, fakeExtension, makeHome, require, text, waitFor } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fixtures", "fake-mcp.mjs");
const cli = (env, ...args) => execFileSync(process.execPath, [distEntry, ...args], { env, encoding: "utf8" });

/** An AI app with the given client capabilities and answers. */
async function app(t, env, { elicit, sample } = {}) {
  const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
  const { StdioClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
  const { ElicitRequestSchema, CreateMessageRequestSchema } = await import(require.resolve("@modelcontextprotocol/sdk/types.js"));
  const capabilities = { ...(elicit ? { elicitation: {} } : {}), ...(sample ? { sampling: {} } : {}) };
  const client = new Client({ name: "app", version: "0" }, { capabilities });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  if (sample) client.setRequestHandler(CreateMessageRequestSchema, sample);
  let stderr = "";
  const transport = new StdioClientTransport({ command: process.execPath, args: [distEntry], env, stderr: "pipe" });
  transport.stderr.on("data", (d) => (stderr += d));
  await client.connect(transport);
  t.after(() => client.close());
  return { client, stderr: () => stderr };
}

async function homeWithTracker() {
  const h = await makeHome();
  cli(h.env, "server", "add", "tracker", "--", process.execPath, FAKE);
  cli(h.env, "server", "test", "tracker");
  return h;
}

test("a server's question goes to the AI app's own prompt", async (t) => {
  const h = await homeWithTracker();
  const asked = [];
  const { client } = await app(t, h.env, { elicit: async (req) => (asked.push(req.params), { action: "accept", content: { confirm: true, reason: "old" } }) });
  const r = await client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/confirm_delete", args: { repo: "acme/old" } } });
  assert.match(text(r), /"action":"accept".*"confirm":true.*"reason":"old"/s);
  assert.match(asked[0].message, /Really delete acme\/old/);
});

test("with the browser connected, a server's question is asked there, one field at a time", async (t) => {
  const h = await homeWithTracker();
  const { client } = await app(t, h.env);
  const asks = [];
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: { ask_user: async (req) => (asks.push(req), req.input ? { choice: "OK", text: "too old", cancelled: false } : { choice: "Yes", cancelled: false }) },
  });
  t.after(() => ext.close());
  const r = await client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/confirm_delete", args: { repo: "acme/old" } } });
  assert.match(text(r), /"confirm":true.*"reason":"too old"/s);
  assert.equal(asks.length, 2);
  assert.deepEqual(asks[0].choices, ["Yes", "No", "Cancel"]);
  assert.equal(asks[1].input.label, "Why");
});

test("a server's text-generation request goes to the AI app; without it, a clear error", async (t) => {
  const h = await homeWithTracker();
  const { client } = await app(t, h.env, { sample: async () => ({ role: "assistant", content: { type: "text", text: "short" }, model: "app-model" }) });
  assert.match(text(await client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/summarize", args: { text: "long text" } } })), /summary: short/);

  const h2 = await homeWithTracker();
  const { client: plain } = await app(t, h2.env);
  const r = await plain.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/summarize", args: { text: "x" } } });
  assert.match(text(r), /anymcp server sampling on/);
});

test("an old SSE-only server works (Streamable HTTP is tried first, then SSE)", async (t) => {
  const srv = spawn(process.execPath, [path.join(here, "fixtures", "fake-sse-mcp.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => srv.kill());
  const port = await new Promise((r) => srv.stdout.once("data", (d) => r(String(d).trim())));
  const h = await makeHome();
  cli(h.env, "server", "add", "old", "--url", `http://127.0.0.1:${port}/sse`);
  assert.match(cli(h.env, "server", "test", "old"), /works: 1 tool/);
  const { client } = await app(t, h.env);
  await waitFor(async () => text(await client.callTool({ name: "search_tools", arguments: { query: "pong" } })).includes("mcp-old/ping") || undefined, 10_000);
  assert.match(text(await client.callTool({ name: "call_tool", arguments: { id: "mcp-old/ping", args: {} } })), /pong/);
});

test("two AI sessions share one copy of a server; questions go back to the session that asked", async (t) => {
  const h = await homeWithTracker();
  const first = await app(t, h.env, { elicit: async () => ({ action: "accept", content: { confirm: false } }) });
  await first.client.listTools();
  const second = await app(t, h.env, { elicit: async () => ({ action: "accept", content: { confirm: true, reason: "second" } }) });
  await waitFor(() => second.stderr().includes("joining") || undefined, 10_000);
  const pidA = text(await first.client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/pid", args: {} } }));
  const pidB = text(await second.client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/pid", args: {} } }));
  assert.equal(pidA, pidB, "the same server process answered both");
  const r = await second.client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/confirm_delete", args: { repo: "x" } } });
  assert.match(text(r), /"reason":"second"/, "the second session's own prompt answered");
});
