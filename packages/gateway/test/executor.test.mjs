import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadLib, makeHome } from "./helpers.mjs";

const lib = await loadLib();

function jsonResponse(body, { status = 200, url } = {}) {
  const res = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url) Object.defineProperty(res, "url", { value: url });
  return res;
}

async function setup({ answer = "always", fetchImpl, browser, extraProfiles = [] } = {}) {
  const h = await makeHome();
  process.env.ANYMCP_HOME = h.home;
  for (const p of extraProfiles) fs.writeFileSync(path.join(h.home, "profiles", `${p.id}.json`), JSON.stringify(p));
  const paths = lib.getPaths();
  const catalog = new lib.Catalog(paths, () => undefined, h.bundled);
  catalog.reload();
  const asked = [];
  const approvals = new lib.Approvals(paths, async (req) => {
    asked.push(req);
    return typeof answer === "function" ? answer(req) : answer;
  });
  const fetches = [];
  const executor = new lib.Executor({
    catalog,
    approvals,
    version: "test",
    browser: browser ?? { connected: false, call: async () => assert.fail("browser should not be used") },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return fetchImpl ? fetchImpl(url, init) : jsonResponse({ daily: [{ day: "Mon", max: 20, min: 10 }] }, { url });
    },
  });
  return { executor, asked, fetches, paths };
}

test("public tool: fetches from the gateway and shapes the response", async () => {
  const { executor, fetches, asked } = await setup();
  const r = await executor.callTool("weather.test/forecast", { city: "Paris" });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(fetches[0].url, "https://api.weather.test/forecast?q=Paris");
  assert.match(fetches[0].init.headers["user-agent"], /^AnyMCP\/test/);
  assert.match(r.content[0].text, /<untrusted-content source="https:\/\/api.weather.test\/forecast\?q=Paris">/);
  assert.match(r.content[0].text, /\[\{"day":"Mon","max":20\}\]/);
  assert.equal(asked.length, 1, "first use asks for the site");
  await executor.callTool("weather.test/forecast", { city: "Rome" });
  assert.equal(asked.length, 1, "site approval is remembered");
});

test("blocks redirects to other hosts", async () => {
  const { executor } = await setup({ fetchImpl: (url) => jsonResponse({}, { url: "https://evil.example/x" }) });
  const r = await executor.callTool("weather.test/forecast", { city: "Paris" });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /redirected to https:\/\/evil.example/);
});

test("non-2xx responses are errors with the status", async () => {
  const { executor } = await setup({ fetchImpl: (url) => jsonResponse({ error: "nope" }, { status: 404, url }) });
  const r = await executor.callTool("weather.test/forecast", { city: "Paris" });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /^HTTP 404/);
});

test("missing arguments and unknown tools", async () => {
  const { executor } = await setup();
  assert.match((await executor.callTool("weather.test/forecast", {})).content[0].text, /Missing required argument\(s\): city/);
  assert.match((await executor.callTool("nope/tool", {})).content[0].text, /No tool called/);
});

test("denied or unavailable approval stops the call", async () => {
  let { executor, fetches } = await setup({ answer: "deny" });
  let r = await executor.callTool("weather.test/forecast", { city: "Paris" });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /declined/);
  assert.equal(fetches.length, 0);
  ({ executor } = await setup({ answer: "unavailable" }));
  r = await executor.callTool("weather.test/forecast", { city: "Paris" });
  assert.match(r.content[0].text, /npx -y anymcp-gateway allow weather.test/);
});

test("browser-session tools go to the extension; mutating tools ask each time", async () => {
  const sent = [];
  const browser = {
    connected: true,
    call: async (method, params) => {
      sent.push({ method, params });
      return { status: 200, url: params.request.url, contentType: "application/json", body: JSON.stringify({ item: { name: "Pen", secret: 1 } }) };
    },
  };
  const { executor, asked } = await setup({ browser, answer: (req) => (req.choices.includes("once") ? "once" : "always") });
  const r = await executor.callTool("example.com/get_item", { id: "a/b", verbose: true });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(sent[0].method, "run_http");
  assert.equal(sent[0].params.request.url, "https://api.example.com/items/a%2Fb?verbose=true");
  assert.equal(sent[0].params.request.headers["x-csrf-token"], "{$meta:csrf-token}");
  assert.deepEqual(sent[0].params.origins, ["https://example.com"]);
  assert.match(r.content[0].text, /\{"name":"Pen"\}/);

  await executor.callTool("example.com/create_item", { name: "Cup" });
  await executor.callTool("example.com/create_item", { name: "Mug" });
  const mutating = asked.filter((a) => a.choices.includes("once"));
  assert.equal(mutating.length, 2, "asked for each mutating call");
  assert.deepEqual(mutating[0].details, ["name: Cup"]);
  assert.equal(sent[1].params.request.body, '{"name":"Cup"}');
});

test("'always' on a mutating tool is remembered", async () => {
  const browser = { connected: true, call: async (_m, p) => ({ status: 201, url: p.request.url, contentType: "text/plain", body: "ok" }) };
  const { executor, asked, paths } = await setup({ browser, answer: "always" });
  await executor.callTool("example.com/create_item", { name: "Cup" });
  await executor.callTool("example.com/create_item", { name: "Mug" });
  assert.equal(asked.length, 2, "site once + tool once");
  assert.deepEqual(lib.loadState(paths).approvals["example.com"].alwaysTools, ["create_item"]);
});

// ---- Recorded-site features: page tools, session values, defaults, JSON values ----

const recorded = {
  schemaVersion: 1,
  id: "social.test",
  name: "Social Test",
  description: "A recorded, signed-in site for tests.",
  version: "0.1.0",
  authors: ["test"],
  categories: ["social"],
  origins: ["https://www.social.test"],
  auth: "browser-session",
  allowedHosts: ["www.social.test"],
  tools: [
    {
      name: "open_profile",
      title: "Open profile",
      description: "Opens a profile page and returns its text.",
      input: { type: "object", properties: { name: { type: "string" }, tab: { type: "string", default: "posts" } }, required: ["name"] },
      mutates: false,
      action: { kind: "page", url: "https://www.social.test/{name}/", query: { tab: "{tab}" }, maxChars: 50 },
    },
    {
      name: "profile_page",
      title: "Profile page",
      description: "Persisted GraphQL query for a profile.",
      input: { type: "object", properties: { id: { type: "string" }, render_surface: { type: "string", default: "PROFILE" } }, required: ["id"] },
      mutates: false,
      action: {
        kind: "http",
        method: "POST",
        url: "https://www.social.test/graphql/query",
        query: { v: { json: { id: "{id}", surface: "{render_surface}" } } },
        headers: { "x-csrftoken": "{$cookie:csrftoken}" },
        body: {
          encoding: "form",
          value: { doc_id: "123", fb_dtsg: "{$live:fb_dtsg}", variables: { json: { id: "{id}", render_surface: "{render_surface}" } } },
        },
      },
    },
  ],
};

test("page tools open the page in the browser and return untrusted text", async () => {
  const sent = [];
  const browser = {
    connected: true,
    call: async (method, params, timeout) => {
      sent.push({ method, params, timeout });
      return { tabId: 3, title: "nasa", url: params.action.url, text: "Profile of NASA. " + "x".repeat(200), truncated: false };
    },
  };
  const { executor, asked } = await setup({ browser, extraProfiles: [recorded] });
  const r = await executor.callTool("social.test/open_profile", { name: "nasa" });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(sent[0].method, "run_page");
  assert.equal(sent[0].params.action.url, "https://www.social.test/nasa/?tab=posts", "default applied");
  assert.equal(sent[0].params.action.maxChars, 50);
  assert.deepEqual(sent[0].params.allowedHosts, ["www.social.test"]);
  assert.ok(sent[0].timeout >= 60_000);
  assert.match(r.content[0].text, /^Title: nasa\nURL: https:\/\/www.social.test\/nasa\/\?tab=posts/);
  assert.match(r.content[0].text, /<untrusted-content source="https:\/\/www.social.test\/nasa\/\?tab=posts">/);
  assert.match(r.content[0].text, /\[truncated/);
  assert.match(asked[0].message, /run in your browser/);
});

test("defaults and {json} values reach run_http; browser placeholders are left for the extension", async () => {
  const sent = [];
  const browser = {
    connected: true,
    call: async (method, params) => {
      sent.push({ method, params });
      return { status: 200, url: params.request.url, contentType: "application/json", body: '{"data":{"ok":true}}' };
    },
  };
  const { executor } = await setup({ browser, extraProfiles: [recorded] });
  const r = await executor.callTool("social.test/profile_page", { id: "777" });
  assert.ok(!r.isError, r.content[0].text);
  const req = sent[0].params.request;
  assert.deepEqual(JSON.parse(new URL(req.url).searchParams.get("v")), { id: "777", surface: "PROFILE" });
  const body = new URLSearchParams(req.body);
  assert.deepEqual(JSON.parse(body.get("variables")), { id: "777", render_surface: "PROFILE" });
  assert.equal(body.get("fb_dtsg"), "{$live:fb_dtsg}");
  assert.equal(body.get("doc_id"), "123");
  assert.equal(req.headers["x-csrftoken"], "{$cookie:csrftoken}");
  assert.doesNotMatch(r.content[0].text, /couldn't find/);
});

test("missing session values get a plain note, on errors and on success", async () => {
  let status = 403;
  const browser = {
    connected: true,
    call: async (_m, params) => ({ status, url: params.request.url, contentType: "application/json", body: '{"error":"no"}', missing: ["live:fb_dtsg", "cookie:csrftoken"] }),
  };
  const { executor } = await setup({ browser, extraProfiles: [recorded] });
  let r = await executor.callTool("social.test/profile_page", { id: "1" });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /HTTP 403/);
  assert.match(r.content[0].text, /couldn't find these session values in the browser, so they were left out: fb_dtsg, csrftoken/);
  assert.match(r.content[0].text, /open https:\/\/www.social.test in Chrome \(signed in\)/);
  status = 200;
  r = await executor.callTool("social.test/profile_page", { id: "1" });
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /left out: fb_dtsg, csrftoken/);
});
