import { test } from "node:test";
import assert from "node:assert/strict";
import { checkArgs, fill, hostAllowed, resolveFormAction, resolveHttpRequest, resolveWebMcpPage, TemplateError } from "../dist/index.js";

const get = (extra = {}) => ({ kind: "http", method: "GET", url: "https://api.example.com/things/{id}", ...extra });

test("path arguments are percent-encoded", () => {
  const r = resolveHttpRequest(get(), { id: "a b/c?" });
  assert.equal(r.url, "https://api.example.com/things/a%20b%2Fc%3F");
});

test("a missing path argument is an error", () => {
  assert.throws(() => resolveHttpRequest(get(), {}), TemplateError);
});

test("query parameters with a missing optional argument are dropped", () => {
  const r = resolveHttpRequest(get({ query: { q: "{q}", limit: "{limit}", fixed: "1", mixed: "x-{missing}" } }), { id: "1", q: "hello world" });
  const u = new URL(r.url);
  assert.equal(u.searchParams.get("q"), "hello world");
  assert.equal(u.searchParams.get("fixed"), "1");
  assert.equal(u.searchParams.has("limit"), false);
  assert.equal(u.searchParams.has("mixed"), false);
});

test("arrays become comma lists, objects become JSON", () => {
  assert.equal(fill("{a}", { a: ["x", "y"] }), "x,y");
  assert.equal(fill("{a}", { a: { b: 1 } }), '{"b":1}');
  assert.equal(fill("n={a}", { a: 0 }), "n=0");
  assert.equal(fill("{a}", { a: null }), undefined);
});

test('a JSON body keeps types for exact "{x}" strings and drops missing keys', () => {
  const action = {
    kind: "http",
    method: "POST",
    url: "https://api.example.com/things",
    body: { encoding: "json", value: { count: "{count}", on: "{on}", tags: "{tags}", label: "n-{count}", nested: { gone: "{missing}", keep: 1 }, list: ["{count}", "{missing}"] } },
  };
  const r = resolveHttpRequest(action, { count: 3, on: false, tags: ["a"] });
  assert.deepEqual(JSON.parse(r.body), { count: 3, on: false, tags: ["a"], label: "n-3", nested: { keep: 1 }, list: [3] });
  assert.equal(r.headers["content-type"], "application/json");
});

test("a JSON body can be a single argument", () => {
  const action = { kind: "http", method: "PUT", url: "https://api.example.com/x", body: { encoding: "json", value: "{body}" } };
  assert.deepEqual(JSON.parse(resolveHttpRequest(action, { body: { a: [1] } }).body), { a: [1] });
});

test("form bodies are url-encoded and drop missing fields", () => {
  const action = { kind: "http", method: "POST", url: "https://api.example.com/x", body: { encoding: "form", value: { q: "{q}", n: 5, gone: "{missing}" } } };
  const r = resolveHttpRequest(action, { q: "a&b" });
  assert.equal(r.body, "q=a%26b&n=5");
  assert.equal(r.headers["content-type"], "application/x-www-form-urlencoded");
});

test("header templates fill, browser placeholders stay untouched", () => {
  const r = resolveHttpRequest(get({ headers: { "x-csrf": "{$cookie:csrf}", "x-a": "{a}", "x-b": "{b}" } }), { id: "1", a: "yes" });
  assert.deepEqual(r.headers, { "x-csrf": "{$cookie:csrf}", "x-a": "yes" });
});

test("checkArgs requires required args and drops unknown ones", () => {
  const input = { type: "object", properties: { a: {}, b: {} }, required: ["a"] };
  assert.throws(() => checkArgs(input, { b: 1 }), /Missing required argument\(s\): a/);
  assert.deepEqual(checkArgs(input, { a: 1, z: 2 }), { a: 1 });
  assert.deepEqual(checkArgs({ type: "object", properties: {} }, undefined), {});
});

test("resolveFormAction maps arguments to selectors", () => {
  const r = resolveFormAction(
    { kind: "form", page: "https://example.com/search/{section}", form: "#f", fields: { q: "input[name=q]", n: "#n" }, result: { read: "#results" } },
    { section: "a b", q: "cats" },
  );
  assert.deepEqual(r, { page: "https://example.com/search/a%20b", form: "#f", fields: { "input[name=q]": "cats" }, submit: undefined, waitFor: undefined, read: "#results", maxChars: 20000 });
  assert.equal(resolveWebMcpPage({ kind: "webmcp", page: "https://example.com/{p}", tool: "t" }, { p: "x" }), "https://example.com/x");
});

test("hostAllowed requires https and an exact host", () => {
  assert.equal(hostAllowed("https://api.example.com/x", ["api.example.com"]), true);
  assert.equal(hostAllowed("http://api.example.com/x", ["api.example.com"]), false);
  assert.equal(hostAllowed("https://api.example.com.evil.com/", ["api.example.com"]), false);
  assert.equal(hostAllowed("nope", ["api.example.com"]), false);
});

test("{+path} keeps slashes and query, stays on the same site", async () => {
  const { resolvePageAction, hostAllowed } = await import("../dist/index.js");
  const a = { kind: "page", url: "https://example.com/{+path}" };
  assert.equal(resolvePageAction(a, { path: "docs/intro?x=1" }).url, "https://example.com/docs/intro?x=1");
  assert.equal(resolvePageAction(a, { path: "" }).url, "https://example.com/");
  assert.equal(resolvePageAction(a, { path: "a b/%20c" }).url, "https://example.com/a%20b/%20c");
  for (const evil of ["//evil.com/x", "/\\evil.com", "@evil.com"]) {
    assert.ok(hostAllowed(resolvePageAction(a, { path: evil }).url, ["example.com"]), evil);
  }
});

test("signed-out detection", async () => {
  const { looksSignedOut, isLoginUrl } = await import("../dist/index.js");
  assert.ok(looksSignedOut({ status: 200, url: "https://www.instagram.com/api/graphql", body: '{"errors":[{"message":"Unauthorized logged out query.","severity":"CRITICAL"}]}' }));
  assert.ok(isLoginUrl("https://www.instagram.com/accounts/login/?next=%2Fdirect%2Finbox%2F"));
  assert.ok(isLoginUrl("https://x.com/i/flow/login"));
  assert.ok(looksSignedOut({ status: 401, url: "https://api.example.com/x", body: "" }));
  assert.ok(!looksSignedOut({ status: 200, url: "https://news.example.com/a", body: "x".repeat(5000) + " the user logged out of the app " }));
  assert.ok(!looksSignedOut({ status: 200, url: "https://api.example.com/items", body: '{"items":[1,2]}' }));
  assert.ok(!isLoginUrl("https://example.com/blog/how-to-login-faster"));
});

test("compactContent drops empty fields, caps size, keeps images", async () => {
  const { compactContent, compactJson } = await import("../dist/index.js");
  assert.deepEqual(compactJson({ a: null, b: "", c: [], d: {}, e: 0, f: false, g: [{ x: null, y: 1 }] }), { e: 0, f: false, g: [{ y: 1 }] });
  const r = compactContent([{ type: "text", text: JSON.stringify({ items: [{ a: 1, b: null }] }, null, 2) }, { type: "image", data: "x", mimeType: "image/png" }]);
  assert.equal(r.content[0].text, '{"items":[{"a":1}]}');
  assert.equal(r.content[1].type, "image");
  assert.ok(r.rawChars > r.returnedChars);
  const big = compactContent([{ type: "text", text: "x".repeat(1000) }], 100);
  assert.match(big.content[0].text, /truncated: 900 more/);
  assert.equal(compactJson(Array.from({ length: 150 }, (_, i) => i)).length, 101);
});
