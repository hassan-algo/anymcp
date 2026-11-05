import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeExtension, makeHome, startGateway, text } from "./helpers.mjs";

test("token savings are counted per call and reported by token_savings", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const big = JSON.stringify({ item: { name: "Cup", description: "x".repeat(4000), price: 3 }, related: Array(50).fill({ a: 1, b: "long text here" }) });
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: {
      request_approval: async () => ({ choice: "always" }),
      run_http: async (p) => ({ status: 200, url: p.request.url, contentType: "application/json", body: big }),
    },
  });
  t.after(() => ext.close());

  await client.listTools();
  const r = await client.callTool({ name: "call_tool", arguments: { id: "example.com/get_item", args: { id: "1" } } });
  assert.ok(!r.isError, text(r));
  await client.callTool({ name: "call_tool", arguments: { id: "example.com/get_item", args: { id: "2" } } });

  const stats = JSON.parse(fs.readFileSync(path.join(h.home, "stats.json"), "utf8"));
  assert.equal(stats.sites["example.com"].calls, 2);
  assert.equal(stats.sites["example.com"].rawChars, big.length * 2);
  assert.ok(stats.sites["example.com"].returnedChars < 100, String(stats.sites["example.com"].returnedChars));
  assert.ok(stats.listedChars > 1000, "tool list size saved for the CLI");

  const s = text(await client.callTool({ name: "token_savings", arguments: {} }));
  assert.match(s, /Saved ≈ [\d.]+k tokens \(\d+%\) across 2 call/);
  assert.match(s, /example\.com: 2 API call\(s\)/);
  assert.match(s, /Tool list:/);
});

test("add_site opens the setup window in the browser with a normalized URL", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const opened = [];
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: { open_setup: async (p) => (opened.push(p.url), { opened: true }) },
  });
  t.after(() => ext.close());

  const r = await client.callTool({ name: "add_site", arguments: { url: "instagram.com" } });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(opened, ["https://instagram.com/"]);
  assert.match(text(r), /Start recording/);
  const bad = await client.callTool({ name: "add_site", arguments: { url: "not a url" } });
  assert.ok(bad.isError);

  const none = text(await client.callTool({ name: "search_tools", arguments: { query: "zzqqxx nothing" } }));
  assert.match(none, /add_site/);
});

test("getStats: per-call savings, tool-list size, reset", async () => {
  const { loadLib } = await import("./helpers.mjs");
  const m = await loadLib();
  const h = await makeHome();
  process.env.ANYMCP_HOME = h.home;
  process.env.ANYMCP_BUNDLED_INDEX = h.bundled;
  const paths = m.getPaths();
  const catalog = new m.Catalog(paths, () => {});
  catalog.reload();
  m.recordUsage(paths, "a.com", 4000, 400);
  const st = m.getStats(paths, catalog, 400);
  assert.equal(st.calls, 1);
  assert.equal(st.savedTokens, 900);
  assert.equal(st.savedPercent, 90);
  assert.ok(st.toolList.toolCount >= 2);
  assert.ok(st.toolList.allToolsTokens > 0);
  m.resetStats(paths);
  assert.equal(m.getStats(paths, catalog, 400).calls, 0);
  delete process.env.ANYMCP_HOME;
  delete process.env.ANYMCP_BUNDLED_INDEX;
});

test("page reads are counted separately: HTML vs the text the AI got", async (t) => {
  const h = await makeHome({ localProfiles: [] });
  const fsP = await import("node:fs");
  const p = {
    schemaVersion: 1, id: "news.test", name: "News", description: "A news site for tests.", version: "1.0.0", authors: ["t"],
    categories: ["news"], origins: ["https://news.test"], auth: "browser-session", allowedHosts: ["news.test"],
    tools: [{ name: "open_path", title: "Open", description: "Opens a page on news.test.", input: { type: "object", properties: { path: { type: "string", default: "" } } }, mutates: false, action: { kind: "page", url: "https://news.test/{+path}" } }],
  };
  fsP.writeFileSync(path.join(h.home, "profiles", "news.test.json"), JSON.stringify(p));
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: {
      request_approval: async () => ({ choice: "always" }),
      run_page: async (a) => ({ tabId: 1, title: "News", url: a.action.url, text: "Top story", truncated: false, htmlChars: 400_000 }),
    },
  });
  t.after(() => ext.close());
  await client.callTool({ name: "call_tool", arguments: { id: "news.test/open_path", args: {} } });
  const s = text(await client.callTool({ name: "token_savings", arguments: {} }));
  assert.match(s, /Page reads: 1 page\(s\), the AI got \d+ tokens of text instead of 100k of page HTML/);
  assert.match(s, /news\.test: 1 page read\(s\), 100k HTML → \d+ text/);
});
