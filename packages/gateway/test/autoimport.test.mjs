import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeExtension, makeHome, startGateway, text, waitFor } from "./helpers.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp.mjs");

function appsWith(h) {
  const file = path.join(h.appsHome, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ numStartups: 5, mcpServers: { anymcp: { command: "npx", args: ["-y", "anymcp-gateway"] }, Tracker: { command: process.execPath, args: [FAKE] } } }, null, 2));
  return file;
}

test("servers in the user's apps are imported automatically; one prompt offers to remove them from the apps", async (t) => {
  const h = await makeHome();
  const file = appsWith(h);
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const asks = [];
  const ext = await fakeExtension({ port: h.port, token: h.token, handlers: { ask_user: async (req) => (asks.push(req), { choice: "Remove from my apps", cancelled: false }) } });
  t.after(() => ext.close());

  await waitFor(() => fs.existsSync(path.join(h.home, "servers.json")) && JSON.parse(fs.readFileSync(path.join(h.home, "servers.json"), "utf8")).servers.tracker, 10_000);
  await waitFor(() => (JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.Tracker ? undefined : true), 10_000);
  assert.equal(asks.length, 1, "one prompt");
  assert.match(asks[0].message, /Found in Claude Code: Tracker/);
  assert.deepEqual(asks[0].choices, ["Remove from my apps", "Keep both", "Don't ask again"]);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(after.mcpServers.anymcp, "AnyMCP itself stays in the app");
  assert.equal(after.numStartups, 5, "the rest of the app's settings are untouched");
  assert.ok(fs.existsSync(`${file}.anymcp-backup`));
  // Its tools are searchable once AnyMCP has started it.
  await waitFor(async () => (text(await client.callTool({ name: "search_tools", arguments: { query: "list issues" } })).includes("mcp-tracker/list_issues") ? true : undefined), 15_000);
});

test("\"Don't ask again\" is remembered; the AI can still import on request", async (t) => {
  const h = await makeHome();
  const file = appsWith(h);
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const asks = [];
  const ext = await fakeExtension({ port: h.port, token: h.token, handlers: { ask_user: async (req) => (asks.push(req), { choice: "Don't ask again", cancelled: false }) } });
  t.after(() => ext.close());
  await waitFor(() => fs.existsSync(path.join(h.home, "import-prompt.json")) || undefined, 10_000);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.Tracker, "kept in the app");
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, "import-prompt.json"), "utf8")).never, true);

  // A new server shows up later: imported, but no prompt.
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.mcpServers.Other = { command: process.execPath, args: [FAKE, "--other"] };
  fs.writeFileSync(file, JSON.stringify(data));
  const r = text(await client.callTool({ name: "import_mcp_servers", arguments: {} }));
  assert.match(r, /AnyMCP now also runs other/);
  assert.equal(asks.length, 1, "no second prompt");
  const r2 = text(await client.callTool({ name: "import_mcp_servers", arguments: { remove_from_apps: true } }));
  assert.match(r2, /No other MCP servers found/);
});
