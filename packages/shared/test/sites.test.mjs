// Recordings shaped like real big sites, plus the browser-placeholder machinery.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferTools,
  ProfileSchema,
  validateProfile,
  scanForPersonalData,
  resolveHttpRequest,
  resolvePageAction,
  checkArgs,
  browserPlaceholders,
  fillBrowserPlaceholders,
  shapeResponse,
} from "../dist/index.js";

const form = "application/x-www-form-urlencoded";

function profileFor(tools, host, auth = "browser-session") {
  return {
    schemaVersion: 1,
    id: host.replace(/^www\./, ""),
    name: "Test",
    description: "Generated in a test.",
    version: "0.1.0",
    authors: ["you"],
    categories: ["social"],
    origins: [`https://${host}`],
    auth,
    allowedHosts: [...new Set(tools.map((t) => new URL(t.action.url ?? t.action.page).host))],
    tools,
  };
}

// ---- Instagram (Facebook-style persisted GraphQL) ---------------------------

const igBody = new URLSearchParams({
  av: "17841400000000000",
  __d: "www",
  __user: "0",
  __a: "1",
  __req: "1b",
  __hs: "20000.HYP:instagram_web_pkg.2.1...0",
  dpr: "2",
  __ccg: "EXCELLENT",
  __rev: "1029000000",
  __s: "abc123:def456:ghi789",
  __hsi: "7500000000000000000",
  __dyn: "7xeUjG1mxu1syUbFp41twpUnwgU7SbzEdF8aUco2qwJw5ux609vCwjE1EE2Cw8G11wBz81s8hwnU6a3a1YwBgao6C0Mo2swtUd8",
  __csr: "gnMx2O4kQZ8OkJlGhvlHlSyiKmF4V9ARhGAmq",
  __comet_req: "7",
  fb_dtsg: "NAcN-abcDEF123:17:1700000000",
  jazoest: "26123",
  lsd: "AVqbxe3J_YA",
  __spin_r: "1029000000",
  __spin_b: "trunk",
  __spin_t: "1730000000",
  fb_api_caller_class: "RelayModern",
  fb_api_req_friendly_name: "PolarisProfilePageContentQuery",
  variables: JSON.stringify({ id: "12345678", render_surface: "PROFILE" }),
  server_timestamps: "true",
  doc_id: "9999999999999999",
}).toString();

const igRequest = {
  method: "POST",
  url: "https://www.instagram.com/graphql/query",
  requestBody: igBody,
  requestContentType: form,
  status: 200,
  responseContentType: "text/javascript; charset=utf-8",
  responseSample: '{"data":{"user":{"username":"x"}}}',
  headers: [
    { name: "x-csrftoken", ref: "cookie:csrftoken" },
    { name: "x-ig-app-id", value: "936619743392459" },
    { name: "x-fb-lsd", ref: "live" },
    { name: "x-asbd-id", value: "129477" },
    { name: "x-fb-friendly-name", value: "PolarisProfilePageContentQuery" },
    { name: "content-type", value: form },
  ],
};

test("Instagram: one tool per GraphQL operation, session codes filled by the browser", () => {
  const { tools, notes } = inferTools([
    igRequest,
    // Noise that used to become a tool:
    { method: "GET", url: "https://static.cdninstagram.com/btmanifest/1029000000/instagram/main", status: 200, responseContentType: "application/json" },
    { method: "POST", url: "https://www.instagram.com/ajax/bz", requestBody: "q=1", requestContentType: form, status: 200, responseContentType: "text/javascript" },
  ]);
  assert.equal(tools.length, 1, tools.map((t) => t.name).join(","));
  const t = tools[0];
  assert.equal(t.name, "profile_page");
  assert.equal(t.mutates, false);
  const v = t.action.body.value;
  assert.equal(t.action.body.encoding, "form");
  assert.equal(v.doc_id, "9999999999999999");
  assert.equal(v.fb_api_req_friendly_name, "PolarisProfilePageContentQuery");
  assert.equal(v.fb_dtsg, "{$live:fb_dtsg}");
  assert.equal(v.lsd, "{$live:lsd}");
  assert.equal(v.av, "{$live:av}");
  assert.deepEqual(v.variables, { json: { id: "{id}", render_surface: "{render_surface}" } });
  assert.deepEqual(t.input.required, ["id"]);
  assert.equal(t.input.properties.render_surface.default, "PROFILE");
  assert.equal(t.action.headers["x-csrftoken"], "{$cookie:csrftoken}");
  assert.equal(t.action.headers["x-fb-lsd"], "{$live:x-fb-lsd}");
  assert.ok(!("content-type" in t.action.headers));
  assert.ok(notes.some((n) => n.includes("fb_dtsg")), notes.join("\n"));

  const json = JSON.stringify(t);
  for (const secret of ["17841400000000000", "NAcN", "AVqbxe3J", "12345678", "abc123:def456"]) {
    assert.ok(!json.includes(secret), `leaked ${secret}`);
  }
  const p = profileFor(tools, "www.instagram.com");
  const r = validateProfile(p);
  assert.ok(r.ok, r.errors?.join("\n"));
  assert.deepEqual(scanForPersonalData(p).filter((f) => f.severity === "block"), []);
});

test("Instagram: running the tool rebuilds a request the site accepts", () => {
  const t = inferTools([igRequest]).tools[0];
  const req = resolveHttpRequest(t.action, checkArgs(t.input, { id: "777" }));
  const ph = browserPlaceholders(req);
  assert.ok(ph.includes("live:fb_dtsg") && ph.includes("cookie:csrftoken") && ph.includes("live:x-fb-lsd"), ph.join(","));
  const { request, missing } = fillBrowserPlaceholders(req, {
    "live:fb_dtsg": "TOKEN:1",
    "live:lsd": "LSD1",
    "live:x-fb-lsd": "LSD1",
    "cookie:csrftoken": "CSRF1",
    "live:av": "1",
  });
  const body = new URLSearchParams(request.body);
  assert.equal(body.get("fb_dtsg"), "TOKEN:1");
  assert.equal(body.get("doc_id"), "9999999999999999");
  assert.deepEqual(JSON.parse(body.get("variables")), { id: "777", render_surface: "PROFILE" });
  assert.equal(request.headers["x-csrftoken"], "CSRF1");
  assert.ok(!body.has("__dyn"), "values the page never sent are left out");
  assert.ok(missing.includes("live:__dyn"));
  assert.ok(!request.body.includes("{$"), "no placeholders left");
});

// ---- X (persisted GraphQL in the path) ----------------------------------------

test("X: /graphql/<id>/<Name> keeps the query id, expands variables, keeps harmless features", () => {
  const u = new URL("https://x.com/i/api/graphql/AbCdEfGhIjKlMnOp12/UserByScreenName");
  u.searchParams.set("variables", JSON.stringify({ screen_name: "jack", withSafetyModeUserFields: true }));
  u.searchParams.set("features", JSON.stringify({ hidden_profile_subscriptions_enabled: true, rweb_tipjar_consumption_enabled: false }));
  const { tools } = inferTools([
    {
      method: "GET",
      url: u.toString(),
      status: 200,
      responseContentType: "application/json",
      headers: [{ name: "authorization", ref: "live" }, { name: "x-csrf-token", ref: "cookie:ct0" }, { name: "x-twitter-active-user", value: "yes" }],
    },
  ]);
  const t = tools[0];
  assert.equal(t.name, "user_by_screen_name");
  assert.equal(t.mutates, false);
  assert.equal(t.action.url, "https://x.com/i/api/graphql/AbCdEfGhIjKlMnOp12/UserByScreenName");
  assert.deepEqual(t.action.query.variables, { json: { screen_name: "{screen_name}", withSafetyModeUserFields: "{with_safety_mode_user_fields}" } });
  assert.equal(typeof t.action.query.features, "string");
  assert.equal(t.action.headers.authorization, "{$live:authorization}");
  assert.equal(t.action.headers["x-csrf-token"], "{$cookie:ct0}");
  assert.deepEqual(t.input.required, ["screen_name"]);
  assert.ok(!JSON.stringify(t).includes("jack"));

  const req = resolveHttpRequest(t.action, checkArgs(t.input, { screen_name: "nasa" }));
  const vars = JSON.parse(new URL(req.url).searchParams.get("variables"));
  assert.deepEqual(vars, { screen_name: "nasa", withSafetyModeUserFields: true });
});

test("mutation names and verbs mark tools as changing data", () => {
  const post = (name) => ({
    method: "POST",
    url: `https://x.com/i/api/graphql/Zz9Yy8Xx7Ww6Vv5Uu4/${name}`,
    requestBody: JSON.stringify({ variables: { tweet_text: "hi" }, queryId: "Zz9Yy8Xx7Ww6Vv5Uu4" }),
    requestContentType: "application/json",
    status: 200,
    responseContentType: "application/json",
  });
  const { tools } = inferTools([post("CreateTweet"), { ...post("SearchTimeline"), method: "GET", requestBody: undefined }]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.create_tweet.mutates, true);
  assert.equal(byName.search_timeline.mutates, false);
  assert.deepEqual(byName.create_tweet.action.body.value.variables, { tweet_text: "{tweet_text}" });
});

// ---- Apollo persisted queries -------------------------------------------------

test("Apollo GET persisted query keeps the hash and gets a default", () => {
  const u = new URL("https://app.example.com/graphql");
  u.searchParams.set("operationName", "GetFeed");
  u.searchParams.set("variables", JSON.stringify({ first: 10, cursor: "Y3Vyc29yOjEyMzQ1Njc4OTAxMjM0NTY3ODkw" }));
  u.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: "a".repeat(64) } }));
  const { tools } = inferTools([{ method: "GET", url: u.toString(), status: 200, responseContentType: "application/json" }]);
  const t = tools[0];
  assert.equal(t.name, "get_feed");
  assert.equal(t.input.properties.first.default, 10);
  assert.equal(t.action.query.variables.json.cursor, "{$live:cursor}", "opaque cursors aren't asked of the AI");
  assert.ok(t.action.query.extensions.includes("sha256Hash"));
  const p = profileFor(tools, "app.example.com");
  assert.ok(validateProfile(p).ok);
  assert.deepEqual(scanForPersonalData(p).filter((f) => f.severity === "block"), [], "public query hashes aren't secrets");
});

// ---- Sites without an API: page visits ----------------------------------------

test("page visits become page tools; usernames become parameters", () => {
  const nav = (url) => ({ kind: "navigation", method: "GET", url, status: 200 });
  const { tools } = inferTools([
    nav("https://www.instagram.com/jane.doe.art/"),
    nav("https://www.instagram.com/natgeo/"),
    nav("https://www.instagram.com/explore/search/keyword/?q=cats&igsh=abc"),
    nav("https://news.example.com/articles/2026/11/some-story-title?utm_source=x"),
  ]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const profile = byName.open_page;
  assert.ok(profile, Object.keys(byName).join(","));
  assert.equal(profile.action.kind, "page");
  assert.equal(profile.action.url, "https://www.instagram.com/{name}/");
  const search = byName.open_search_keyword;
  assert.ok(search, Object.keys(byName).join(","));
  assert.deepEqual(search.action.query, { q: "{q}" });
  assert.ok(!JSON.stringify(tools).includes("jane.doe"));
  assert.ok(!JSON.stringify(tools).includes("utm_source"));
  for (const t of tools) assert.equal(t.mutates, false);
  const p = { ...profileFor(tools.filter((t) => t.action.url.includes("instagram")), "www.instagram.com") };
  assert.ok(validateProfile(p).ok, validateProfile(p).errors?.join("\n"));
  const page = resolvePageAction(profile.action, checkArgs(profile.input, { name: "nasa" }));
  assert.equal(page.url, "https://www.instagram.com/nasa/");
});

// ---- Templates and schema -----------------------------------------------------

test("JSON query values, defaults and JSON bodies with placeholders", () => {
  const action = {
    kind: "http",
    method: "POST",
    url: "https://api.example.com/q",
    query: { v: { json: { a: "{a}", n: "{n}" } } },
    headers: { "x-token": "{$meta:csrf-token}" },
    body: { encoding: "json", value: { token: "{$live:token}", keep: "x", gone: "{$live:nothing}" } },
  };
  const input = { type: "object", properties: { a: { type: "string" }, n: { type: "integer", default: 5 } } };
  const req = resolveHttpRequest(action, checkArgs(input, { a: 'he said "hi"' }));
  assert.deepEqual(JSON.parse(new URL(req.url).searchParams.get("v")), { a: 'he said "hi"', n: 5 });
  const { request, missing } = fillBrowserPlaceholders(req, { "meta:csrf-token": "M1", "live:token": 'T"1' });
  assert.equal(request.headers["x-token"], "M1");
  assert.deepEqual(JSON.parse(request.body), { token: 'T"1', keep: "x" });
  assert.deepEqual(missing, ["live:nothing"]);
});

test("schema: placeholders need browser-session; unknown placeholders are rejected", () => {
  const tool = (headers) => ({
    name: "tt",
    title: "T",
    description: "A test tool here.",
    input: { type: "object", properties: {} },
    mutates: false,
    action: { kind: "http", method: "GET", url: "https://api.example.com/x", headers },
  });
  const base = profileFor([tool({ a: "{$live:x}" })], "api.example.com");
  assert.ok(ProfileSchema.safeParse(base).success);
  assert.ok(!ProfileSchema.safeParse({ ...base, auth: "none" }).success);
  assert.ok(!ProfileSchema.safeParse(profileFor([tool({ a: "{$env:HOME}" })], "api.example.com")).success);
});

test("JSON hidden behind anti-script prefixes is parsed", () => {
  assert.equal(shapeResponse('for (;;);{"a":1}', "application/json", undefined), '{"a":1}');
  assert.equal(shapeResponse(")]}'\n[1,2]", "application/json", undefined), "[1,2]");
});

// ---- Learning from real Instagram traffic -----------------------------------

const gql = (name, variables, extra = {}) => ({
  method: "POST",
  url: "https://www.instagram.com/api/graphql",
  requestBody: new URLSearchParams({ fb_dtsg: "NAcN-x:1", fb_api_req_friendly_name: name, variables: JSON.stringify(variables), doc_id: "123456789", ...extra.body }).toString(),
  requestContentType: form,
  status: 200,
  responseContentType: "application/json",
  responseSample: extra.response,
  headers: [{ name: "x-fb-friendly-name", ref: "live" }, { name: "x-csrftoken", ref: "cookie:csrftoken" }],
});

test("background calls are skipped; usernames in API paths become parameters", () => {
  const { tools, notes } = inferTools([
    gql("PolarisAdToolsAllBoostAdsQuery", { count: 1 }),
    gql("QuickPromotionSupportIGSchemaBatchFetchQuery", {}),
    gql("IGDInboxTrayQuery", {}),
    { method: "GET", url: "https://www.instagram.com/api/v1/web/get_profile_pic_props/acme.studio", status: 200, responseContentType: "application/json" },
    { method: "GET", url: "https://api.example.com/v1/get_user_info", status: 200, responseContentType: "application/json" },
    { method: "POST", url: "https://www.instagram.com/ajax/route-definition/", requestBody: "a=1", requestContentType: form, status: 200, responseContentType: "text/javascript" },
  ]);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_get_profile_pic_prop", "get_get_user_info", "igd_inbox_tray"].sort(), names.join(","));
  assert.ok(notes.some((n) => /Skipped 2 background/.test(n)), notes.join("\n"));
  assert.ok(!JSON.stringify(tools).includes("acme.studio"));
  assert.equal(tools.find((t) => t.name === "get_get_user_info").action.url, "https://api.example.com/v1/get_user_info");
});

test("friendly-name header is the tool's own operation; page-invented ids are generated per call", () => {
  const { tools } = inferTools([
    gql("IGDirectTextSendMutation", { ig_thread_igid: "340282366841710300949128123456789012", offline_threading_id: "7390012345678901234", text: "working" }),
  ]);
  const t = tools[0];
  assert.equal(t.name, "ig_direct_text_send");
  assert.equal(t.mutates, true);
  assert.equal(t.action.headers["x-fb-friendly-name"], "IGDirectTextSendMutation");
  assert.equal(t.action.body.value.variables.json.offline_threading_id, "{$rand:19}");
  assert.ok(!("offline_threading_id" in t.input.properties));
  const a = resolveHttpRequest(t.action, checkArgs(t.input, { ig_thread_igid: "1", text: "hi" }));
  const b = resolveHttpRequest(t.action, checkArgs(t.input, { ig_thread_igid: "1", text: "hi" }));
  const id = (r) => JSON.parse(new URLSearchParams(r.body).get("variables")).offline_threading_id;
  assert.match(id(a), /^\d{19}$/);
  assert.notEqual(id(a), id(b), "fresh id each call");
  assert.ok(validateProfile(profileFor(tools, "www.instagram.com")).ok);
});

test("ids get hints: from a page address or from another tool's result", () => {
  const thread = "340282366841710300949128123456789012";
  const { tools } = inferTools([
    gql("IGDInboxTrayQuery", {}, { response: `{"data":{"threads":[{"thread_fbid":"${thread}","title":"Hassan"}]}}` }),
    { kind: "navigation", method: "GET", url: `https://www.instagram.com/direct/t/${thread}/`, status: 200 },
    gql("IGDThreadDetailQuery", { thread_fbid: thread }),
  ]);
  const detail = tools.find((t) => t.name === "igd_thread_detail");
  const d = detail.input.properties.thread_fbid.description;
  assert.ok(/page address https:\/\/www\.instagram\.com\/direct\/t\/\{t_id\}\//.test(d) || /result of igd_inbox_tray/.test(d), d);
  assert.ok(!JSON.stringify(tools).includes(thread), "the recorded id itself is never stored");
});

test("toolSignature tells recorded copies of the same call apart from new ones", async () => {
  const { toolSignature } = await import("../dist/index.js");
  const one = inferTools([gql("IGDInboxTrayQuery", {})]).tools[0];
  const again = inferTools([gql("IGDInboxTrayQuery", { x: 1 })]).tools[0];
  const other = inferTools([gql("IGDThreadDetailQuery", {})]).tools[0];
  assert.equal(toolSignature(one), toolSignature(again));
  assert.notEqual(toolSignature(one), toolSignature(other));
});

test("hidden flags inside variables are kept; object inputs describe their keys", () => {
  const { tools } = inferTools([
    gql("IGDirectTextSendMutation", {
      ig_thread_igid: "340282366841710300949128123456789012",
      text: { sensitive_string_value: "working" },
      send_attribution: "direct_thread",
      __relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider: false,
    }),
  ]);
  const t = tools[0];
  const v = t.action.body.value.variables.json;
  assert.equal(v.__relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider, false);
  assert.match(t.input.properties.text.description, /sensitive_string_value/);
  assert.equal(t.input.properties.send_attribution.default, "direct_thread");
  assert.ok(!JSON.stringify(t).includes("working"));
});

test("calls that hand out credentials are never turned into tools", () => {
  const { tools } = inferTools([
    { method: "POST", url: "https://www.instagram.com/api/v1/ads/promote/fetch_business_person_access_token", requestBody: "a=1", requestContentType: form, status: 200, responseContentType: "application/json" },
    gql("ChangePasswordMutation", { new_password: "x" }),
    gql("IGDInboxTrayQuery", {}),
  ]);
  assert.deepEqual(tools.map((t) => t.name), ["igd_inbox_tray"]);
});

test("operationKey sees the same action across query-id changes", async () => {
  const { operationKey, toolSignature } = await import("../dist/index.js");
  const old = inferTools([gql("IGDInboxTrayQuery", {})]).tools[0];
  const fresh = structuredClone(old);
  fresh.action.body.value.doc_id = "999";
  assert.equal(operationKey(old), operationKey(fresh));
  const x1 = inferTools([{ method: "GET", url: "https://x.com/i/api/graphql/AAAAAAAAAAAA/UserTweets", status: 200, responseContentType: "application/json" }]).tools[0];
  const x2 = inferTools([{ method: "GET", url: "https://x.com/i/api/graphql/BBBBBBBBBBBB/UserTweets", status: 200, responseContentType: "application/json" }]).tools[0];
  assert.equal(operationKey(x1), operationKey(x2));
  assert.notEqual(operationKey(x1), operationKey(inferTools([gql("IGDThreadDetailQuery", {})]).tools[0]));
});
