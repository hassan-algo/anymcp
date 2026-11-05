import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { distEntry, fakeExtension, makeHome, startGateway, text, waitFor } from "./helpers.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp.mjs");
const cli = (env, ...args) => execFileSync(process.execPath, [distEntry, ...args], { env, encoding: "utf8" });

test("another MCP server's tools are served through the catalog, compacted and counted", async (t) => {
  const h = await makeHome();
  assert.match(cli(h.env, "server", "add", "tracker", "--", process.execPath, FAKE), /Added "tracker"/);
  assert.match(cli(h.env, "server", "test", "tracker"), /works: 7 tool\(s\)\. That's about \d+ tokens/);
  assert.match(cli(h.env, "server", "list"), /tracker\s+7 tools/);

  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const listed = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(!listed.some((n) => n.includes("list_issues")), "server tools are not loaded into the AI's tool list");

  const found = text(await client.callTool({ name: "search_tools", arguments: { query: "list issues" } }));
  assert.match(found, /mcp-tracker\/list_issues/);
  const desc = text(await client.callTool({ name: "describe_tool", arguments: { id: "mcp-tracker/list_issues" } }));
  assert.match(desc, /"repo"/);

  const r = await client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/list_issues", args: { repo: "acme/app", limit: 30 } } });
  assert.ok(!r.isError, text(r));
  const out = text(r);
  assert.ok(!out.includes("null") && !out.includes('"labels"'), "empty fields dropped");
  assert.equal(JSON.parse(out).items.length, 30);

  const stats = JSON.parse(fs.readFileSync(path.join(h.home, "stats.json"), "utf8")).sites["mcp-tracker"];
  assert.equal(stats.calls, 1);
  assert.ok(stats.rawChars > stats.returnedChars * 1.8, JSON.stringify(stats));

  // A tool whose name says it writes needs approval (no browser connected, so it can't ask).
  const w = await client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/create_issue", args: { repo: "a", title: "Bug" } } });
  assert.ok(w.isError);
  assert.match(text(w), /approval/i);

  // Pinning a server tool makes it a regular tool with its real schema.
  await client.callTool({ name: "pin", arguments: { target: "mcp-tracker/whoami" } });
  await waitFor(async () => (await client.listTools()).tools.find((x) => x.name === "mcp_tracker__whoami"));
  assert.match(text(await client.callTool({ name: "mcp_tracker__whoami", arguments: {} })), /tester/);
});

test("writes to another server ask first, then run", async (t) => {
  const h = await makeHome();
  cli(h.env, "server", "add", "tracker", "--", process.execPath, FAKE);
  cli(h.env, "server", "test", "tracker");
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const asked = [];
  const ext = await fakeExtension({ port: h.port, token: h.token, handlers: { request_approval: async (req) => (asked.push(req), { choice: "once" }) } });
  t.after(() => ext.close());
  const r = await client.callTool({ name: "call_tool", arguments: { id: "mcp-tracker/create_issue", args: { repo: "a", title: "Bug" } } });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Bug/);
  assert.equal(asked.length, 1, "only the data change asks; no site approval for your own server");
});

test("import copies servers from an app's config and skips AnyMCP itself", async () => {
  const h = await makeHome();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "anymcp-userhome-"));
  fs.writeFileSync(
    path.join(fakeHome, ".claude.json"),
    JSON.stringify({ mcpServers: { anymcp: { command: "npx", args: ["-y", "anymcp-gateway"] }, Tracker: { command: process.execPath, args: [FAKE] }, remote: { type: "http", url: "https://mcp.example.com/mcp" }, old: { type: "sse", url: "https://x" } } }),
  );
  const out = cli({ ...h.env, HOME: fakeHome }, "server", "import", "claude-code");
  assert.match(out, /Imported 3: tracker, remote, old/);
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, "servers.json"), "utf8")).servers;
  assert.deepEqual(Object.keys(saved).sort(), ["old", "remote", "tracker"]);
  assert.equal(saved.old.transport, "sse", "old SSE servers are imported with the SSE transport");
});
