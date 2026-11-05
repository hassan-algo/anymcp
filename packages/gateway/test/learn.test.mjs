import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadLib, makeHome, startGateway, text } from "./helpers.mjs";

const form = "application/x-www-form-urlencoded";
const gql = (name, variables, response) => ({
  method: "POST",
  url: "https://www.instagram.com/api/graphql",
  requestBody: new URLSearchParams({ fb_dtsg: "SECRET:1", fb_api_req_friendly_name: name, variables: JSON.stringify(variables), doc_id: "42" }).toString(),
  requestContentType: form,
  status: 200,
  responseContentType: "application/json",
  responseSample: response,
  headers: [{ name: "x-csrftoken", ref: "cookie:csrftoken" }],
  at: Date.now(),
});

async function setup(h) {
  const m = await loadLib();
  process.env.ANYMCP_HOME = h.home;
  process.env.ANYMCP_BUNDLED_INDEX = h.bundled;
  const paths = m.getPaths();
  const catalog = new m.Catalog(paths, () => {});
  catalog.reload();
  return { m, paths, catalog };
}

test("learning adds new tools once, merges into the site's own profile, keeps no recorded values", async () => {
  const h = await makeHome();
  const { m, paths, catalog } = await setup(h);
  const reqs = [gql("IGDInboxTrayQuery", {}), gql("IGDThreadDetailQuery", { thread_fbid: "340282366841710300949128123456789012" }), gql("PolarisAdToolsAllBoostAdsQuery", {})];

  const first = m.learnFromActivity(catalog, paths, "https://www.instagram.com/direct/inbox/", reqs);
  assert.deepEqual(first.added.sort(), ["instagram.com/igd_inbox_tray", "instagram.com/igd_thread_detail", "instagram.com/open_path"]);
  catalog.reload();
  const p = catalog.get("instagram.com").profile;
  assert.equal(p.auth, "browser-session");
  assert.match(p.tools[1].description, /Learned from your AI's work on \d{4}-\d{2}-\d{2}\./);
  const saved = fs.readFileSync(path.join(h.home, "profiles", "instagram.com.json"), "utf8");
  assert.ok(!saved.includes("SECRET") && !saved.includes("340282366841710300949128123456789012"), "no recorded values stored");

  const again = m.learnFromActivity(catalog, paths, "https://www.instagram.com/", [gql("IGDInboxTrayQuery", {}), gql("IGDDirectTextSendMutation", { text: "hi" })]);
  assert.deepEqual(again.added, ["instagram.com/igd_direct_text_send"]);
  assert.equal(again.known, 1);
  catalog.reload();
  const p2 = catalog.get("instagram.com").profile;
  assert.equal(p2.tools.length, 4);
  assert.equal(p2.version, "0.1.1", "merged into the same profile");
  assert.equal(m.readNotices(paths).length, 2);
  delete process.env.ANYMCP_HOME;
  delete process.env.ANYMCP_BUNDLED_INDEX;
});

test("learning never overrides a registry profile; it makes a separate learned one", async () => {
  const h = await makeHome();
  const { m, paths, catalog } = await setup(h);
  // weather.test is a bundled (registry) profile in the test home.
  const r = m.learnFromActivity(catalog, paths, "https://weather.test/", [
    { method: "GET", url: "https://weather.test/api/alerts?region=north", status: 200, responseContentType: "application/json" },
  ]);
  assert.equal(r.profileId, "weather.test-learned");
  catalog.reload();
  assert.equal(catalog.get("weather.test").source, "bundled", "registry profile untouched");
  delete process.env.ANYMCP_HOME;
  delete process.env.ANYMCP_BUNDLED_INDEX;
});

test("the AI hears about newly learned tools on its next call, once", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const { m, paths, catalog } = await setup(h);
  await new Promise((r) => setTimeout(r, 20));
  m.learnFromActivity(catalog, paths, "https://www.instagram.com/", [gql("IGDInboxTrayQuery", {})]);

  const r1 = text(await client.callTool({ name: "list_categories", arguments: {} }));
  assert.match(r1, /AnyMCP learned 2 new tool\(s\).*instagram\.com\/open_path.*instagram\.com\/igd_inbox_tray/s);
  const r2 = text(await client.callTool({ name: "list_categories", arguments: {} }));
  assert.doesNotMatch(r2, /AnyMCP learned/);
  await new Promise((r) => setTimeout(r, 1200)); // catalog notices the new file
  const found = text(await client.callTool({ name: "search_tools", arguments: { query: "inbox tray" } }));
  assert.match(found, /instagram\.com\/igd_inbox_tray/);
  delete process.env.ANYMCP_HOME;
  delete process.env.ANYMCP_BUNDLED_INDEX;
});

test("a click that matches an existing tool tells the AI which tool and the ids it used", async (t) => {
  const h = await makeHome();
  const { m, paths, catalog } = await setup(h);
  const thread = "340282366841710300949128123456789012";
  const send = (text) => ({ ...gql("IGDirectTextSendMutation", { ig_thread_igid: thread, text: { sensitive_string_value: text } }), trigger: "action" });
  m.learnFromActivity(catalog, paths, "https://www.instagram.com/direct/t/1/", [send("test")]);
  catalog.reload();

  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  await new Promise((r) => setTimeout(r, 20));
  const r = m.learnFromActivity(catalog, paths, "https://www.instagram.com/direct/t/1/", [send("Learned from MCP")]);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.matched, ["instagram.com/ig_direct_text_send"]);
  const note = text(await client.callTool({ name: "list_categories", arguments: {} }));
  assert.match(note, /Your clicks just did what the tool instagram\.com\/ig_direct_text_send does/);
  assert.ok(note.includes(thread), "the AI gets the thread id for next time");
  const saved = fs.readFileSync(path.join(h.home, "learned.json"), "utf8");
  assert.ok(!saved.includes("Learned from MCP"), "message text is never kept");
  delete process.env.ANYMCP_HOME;
  delete process.env.ANYMCP_BUNDLED_INDEX;
});

test("opening a page only learns the calls that read data", async () => {
  const h = await makeHome();
  const { m, paths, catalog } = await setup(h);
  const nav = (name, v = {}) => ({ ...gql(name, v), trigger: "navigate" });
  const r = m.learnFromActivity(catalog, paths, "https://www.instagram.com/", [
    nav("FeedTimelineRootV2Query"),
    nav("CreateIGSSOUserMutation"),
    { method: "POST", url: "https://www.instagram.com/instagram/", requestBody: "a=1", requestContentType: form, status: 200, responseContentType: "application/json", trigger: "navigate" },
  ]);
  assert.deepEqual(r.added, ["instagram.com/open_path", "instagram.com/feed_timeline_root_v2"]);
  delete process.env.ANYMCP_HOME;
  delete process.env.ANYMCP_BUNDLED_INDEX;
});

test("a site the AI only read gets an entry: open_path plus page tools that take inputs", async (t) => {
  const h = await makeHome();
  const { m, paths, catalog } = await setup(h);
  const nav = (url) => ({ kind: "navigation", method: "GET", url, status: 200, trigger: "navigate", at: Date.now() });
  const r = m.learnFromActivity(catalog, paths, "https://news.example.org/", [
    nav("https://news.example.org/"),
    nav("https://news.example.org/search?q=elections"),
    nav("https://news.example.org/about"),
  ]);
  assert.deepEqual(r.added.sort(), ["news.example.org/open_path", "news.example.org/open_search"]);
  catalog.reload();
  const p = catalog.get("news.example.org").profile;
  assert.equal(p.name, "news.example.org");
  assert.ok(!JSON.stringify(p).includes("elections"));

  // Next time: search finds it, and open_path opens the right page.
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const found = text(await client.callTool({ name: "search_tools", arguments: { query: "news example" } }));
  assert.match(found, /news\.example\.org\/open_path/);
  const { fakeExtension } = await import("./helpers.mjs");
  const opened = [];
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: {
      request_approval: async () => ({ choice: "always" }),
      run_page: async (p) => (opened.push(p.action.url), { tabId: 1, title: "News", url: p.action.url, text: "Headlines", truncated: false }),
    },
  });
  t.after(() => ext.close());
  const res = await client.callTool({ name: "call_tool", arguments: { id: "news.example.org/open_path", args: { path: "world/asia?page=2" } } });
  assert.ok(!res.isError, text(res));
  assert.deepEqual(opened, ["https://news.example.org/world/asia?page=2"]);
  delete process.env.ANYMCP_HOME;
  delete process.env.ANYMCP_BUNDLED_INDEX;
});

test("tools improve themselves: new query id, new inputs, and rebuilt after failing", async (t) => {
  const h = await makeHome();
  const { m, paths, catalog } = await setup(h);
  const act = (r) => ({ ...r, trigger: "action" });
  m.learnFromActivity(catalog, paths, "https://www.instagram.com/", [act(gql("IGDInboxTrayQuery", { first: 10 }))]);
  catalog.reload();

  // Site changed its query id and added an input.
  const changed = act(gql("IGDInboxTrayQuery", { first: 10, folder: "PRIMARY_FOLDER_LONG" }));
  changed.requestBody = changed.requestBody.replace("doc_id=42", "doc_id=777");
  const r = m.learnFromActivity(catalog, paths, "https://www.instagram.com/", [changed]);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.improved, ["instagram.com/igd_inbox_tray"]);
  catalog.reload();
  let tool = catalog.get("instagram.com").profile.tools.find((x) => x.name === "igd_inbox_tray");
  assert.equal(tool.action.body.value.doc_id, "777");
  assert.ok("folder" in tool.input.properties);
  assert.equal(tool.action.body.value.variables.json.folder, "{folder}");
  const notice = m.readNotices(paths).at(-1);
  assert.match(notice.improved[0].changes.join(" "), /new query id/);

  // It fails, then the AI does it by hand and the site sends a different shape: rebuild it.
  m.recordToolHealth(paths, "instagram.com/igd_inbox_tray", false);
  const reshaped = act(gql("IGDInboxTrayQuery", { limit: 20 }));
  reshaped.url = "https://www.instagram.com/graphql/query";
  const r2 = m.learnFromActivity(catalog, paths, "https://www.instagram.com/", [reshaped]);
  assert.deepEqual(r2.improved, ["instagram.com/igd_inbox_tray"]);
  catalog.reload();
  tool = catalog.get("instagram.com").profile.tools.find((x) => x.name === "igd_inbox_tray");
  assert.equal(tool.action.url, "https://www.instagram.com/graphql/query");
  assert.ok(m.readNotices(paths).at(-1).improved[0].changes.includes("it had stopped working"));
  delete process.env.ANYMCP_HOME;
  delete process.env.ANYMCP_BUNDLED_INDEX;
});

test("failing site calls are remembered, and cleared when the tool works again", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const { fakeExtension } = await import("./helpers.mjs");
  let status = 500;
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: {
      request_approval: async () => ({ choice: "always" }),
      run_http: async (p) => ({ status, url: p.request.url, contentType: "application/json", body: '{"item":{"name":"x"}}' }),
    },
  });
  t.after(() => ext.close());
  const healthFile = path.join(h.home, "health.json");
  await client.callTool({ name: "call_tool", arguments: { id: "example.com/get_item", args: { id: "1" } } });
  assert.ok("example.com/get_item" in JSON.parse(fs.readFileSync(healthFile, "utf8")));
  status = 200;
  await client.callTool({ name: "call_tool", arguments: { id: "example.com/get_item", args: { id: "1" } } });
  assert.ok(!("example.com/get_item" in JSON.parse(fs.readFileSync(healthFile, "utf8"))));
});
