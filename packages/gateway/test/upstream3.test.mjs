import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { distEntry, makeHome, require, text, waitFor } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fixtures", "fake-mcp.mjs");
const cli = (env, ...args) => execFileSync(process.execPath, [distEntry, ...args], { env, encoding: "utf8" });

async function app(t, env, { elicit } = {}) {
  const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
  const { StdioClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
  const { ElicitRequestSchema } = await import(require.resolve("@modelcontextprotocol/sdk/types.js"));
  const client = new Client({ name: "app", version: "0" }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  let stderr = "";
  const transport = new StdioClientTransport({ command: process.execPath, args: [distEntry], env, stderr: "pipe" });
  transport.stderr.on("data", (d) => (stderr += d));
  await client.connect(transport);
  t.after(() => client.close());
  return { client, stderr: () => stderr };
}

test("two sessions calling one server at the same time each answer their own question", async (t) => {
  const h = await makeHome();
  cli(h.env, "server", "add", "tracker", "--", process.execPath, FAKE);
  cli(h.env, "server", "test", "tracker");
  const a = await app(t, h.env, { elicit: async () => ({ action: "accept", content: { reason: "from A" } }) });
  await a.client.listTools();
  const b = await app(t, h.env, { elicit: async () => ({ action: "accept", content: { reason: "from B" } }) });
  await waitFor(() => b.stderr().includes("joining") || undefined, 10_000);
  const call = (s, label) => s.client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/slow_confirm", args: { label } } }).then(text);
  // Overlapping calls: A twice, B once, all started together.
  const [r1, r2, r3] = await Promise.all([call(a, "a1"), call(b, "b1"), call(a, "a2")]);
  assert.equal(r1, "a1: from A");
  assert.equal(r2, "b1: from B");
  assert.equal(r3, "a2: from A");
});

test("sampling fallback calls the Claude API with the right request, only when turned on", async (t) => {
  const api = spawn(process.execPath, [path.join(here, "fixtures", "fake-claude-api.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => api.kill());
  let seen = "";
  api.stderr.on("data", (d) => (seen += d));
  const port = await new Promise((r) => api.stdout.once("data", (d) => r(String(d).trim())));
  const h = await makeHome();
  cli(h.env, "server", "add", "tracker", "--", process.execPath, FAKE);
  cli(h.env, "server", "test", "tracker");
  assert.match(cli(h.env, "server", "sampling", "on", "--api-key", "sk-test-123"), /Sampling fallback is on: .*claude-opus-5-5/);
  const env = { ...h.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
  const { client } = await app(t, env);
  const r = await client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/summarize", args: { text: "a long article" } } });
  assert.equal(text(r), "summary: a short summary");
  const sent = JSON.parse(seen.trim().split("\n")[0]);
  assert.equal(sent.url, "/v1/messages");
  // The SDK sends the saved key (as x-api-key or a bearer token, depending on its version).
  assert.ok(sent.headers["x-api-key"] === "sk-test-123" || sent.headers.authorization === "Bearer sk-test-123", JSON.stringify(sent.headers));
  assert.match(sent.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(sent.body.model, "claude-opus-5-5");
  assert.equal(sent.body.max_tokens, 50);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.fallbacks, "default");
  assert.deepEqual(sent.body.messages, [{ role: "user", content: [{ type: "text", text: "Summarize: a long article" }] }]);
  assert.match(cli(h.env, "server", "sampling", "off"), /is off/);
});

test("MCP savings: trimmed responses, plus tool definitions kept out of each AI session", async (t) => {
  const fs = await import("node:fs");
  const h = await makeHome();
  cli(h.env, "server", "add", "tracker", "--", process.execPath, FAKE);
  cli(h.env, "server", "test", "tracker");
  const { client } = await app(t, h.env);
  await client.listTools();
  const desc = text(await client.callTool({ name: "describe_tool", arguments: { id: "mcp-tracker/list_issues" } }));
  await client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/list_issues", args: { repo: "a/b", limit: 30 } } });

  const file = JSON.parse(fs.readFileSync(path.join(h.home, "stats.json"), "utf8"));
  assert.equal(file.sessions, 1);
  assert.ok(file.mcpDefinitionChars > 1000, String(file.mcpDefinitionChars));
  assert.equal(file.mcpDescribedChars, desc.length, "what describe_tool showed is subtracted");

  const s = text(await client.callTool({ name: "token_savings", arguments: {} }));
  assert.match(s, /Other MCP servers: 1 call\(s\), responses trimmed by ≈ [\d.]+k?; their tool definitions stayed out of 1 AI session\(s\), ≈ \d+ tokens/);
  assert.match(s, /tracker: 7 tools \(≈ \d+ tokens kept out of each conversation\), 1 call\(s\)/);
  assert.match(s, /mcp-tracker \(MCP server\): 1 call/);
  assert.match(s, /Estimated total: saved ≈ [1-9][\d.]*k? tokens/);
});
