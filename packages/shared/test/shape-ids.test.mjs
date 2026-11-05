import { test } from "node:test";
import assert from "node:assert/strict";
import { getPath, htmlToText, originMatches, parseToolId, pinnedToolName, shapeResponse, toolId, truncate } from "../dist/index.js";

const body = JSON.stringify({
  data: { items: [{ id: 1, name: "a", meta: { url: "u1", secret: "x" } }, { id: 2, name: "b", meta: { url: "u2" } }] },
});

test("pick follows dot paths and array indexes", () => {
  assert.equal(shapeResponse(body, "application/json", { pick: "data.items.1.name" }), '"b"');
  assert.equal(getPath({ a: [{ b: 1 }] }, "a.0.b"), 1);
  assert.equal(getPath({ a: 1 }, "a.b.c"), undefined);
});

test("fields keep dot paths on each array item", () => {
  const out = JSON.parse(shapeResponse(body, "application/json", { pick: "data.items", fields: ["id", "meta.url"] }));
  assert.deepEqual(out, [{ id: 1, meta: { url: "u1" } }, { id: 2, meta: { url: "u2" } }]);
});

test("fields work on a single object", () => {
  assert.deepEqual(JSON.parse(shapeResponse('{"a":1,"b":2}', "application/json", { fields: ["b"] })), { b: 2 });
});

test("a missing pick returns null", () => {
  assert.equal(shapeResponse(body, "application/json", { pick: "nope" }), "null");
});

test("JSON is detected without a JSON content type", () => {
  assert.equal(shapeResponse('[1, 2]', "text/plain", undefined), "[1,2]");
});

test("long output is truncated with a note", () => {
  const out = shapeResponse("x".repeat(100), "text/plain", { maxChars: 10 });
  assert.match(out, /^x{10}\n\n\[truncated: 90 more characters\]$/);
  assert.equal(truncate("abc", 5), "abc");
});

test("HTML becomes text without scripts or styles", () => {
  const html = "<!doctype html><html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>A &amp; B</p><p>C<br>D</p></body></html>";
  const out = shapeResponse(html, "text/html", undefined);
  assert.equal(out.includes("alert"), false);
  assert.equal(out.includes("p{}"), false);
  assert.match(out, /Title/);
  assert.match(out, /A & B/);
  assert.equal(htmlToText("<b>x</b>&lt;y&gt;"), "x <y>");
});

test("tool ids round-trip", () => {
  assert.equal(toolId("news.ycombinator.com", "search_stories"), "news.ycombinator.com/search_stories");
  assert.deepEqual(parseToolId("news.ycombinator.com/search_stories"), { profileId: "news.ycombinator.com", toolName: "search_stories" });
  assert.equal(parseToolId("nope"), undefined);
  assert.equal(parseToolId("a/"), undefined);
});

test("pinned tool names are valid MCP names of at most 64 chars", () => {
  assert.equal(pinnedToolName("news.ycombinator.com", "search_stories"), "news_ycombinator_com__search_stories");
  assert.equal(pinnedToolName("www.github.com", "x"), "github_com__x");
  const long = pinnedToolName("a-very-long-subdomain.with-many-parts.example-company.co.uk", "search_everything_in_the_workspace_now");
  assert.ok(long.length <= 64, long);
  assert.match(long, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(long, pinnedToolName("a-very-long-subdomain.with-many-parts.example-company.co.uk", "search_everything_in_the_workspace_now_2"));
});

test("originMatches covers subdomains and www", () => {
  const o = ["https://github.com"];
  assert.equal(originMatches(o, "https://github.com/foo"), true);
  assert.equal(originMatches(o, "https://gist.github.com/"), true);
  assert.equal(originMatches(o, "https://www.github.com/"), true);
  assert.equal(originMatches(o, "https://notgithub.com/"), false);
  assert.equal(originMatches(o, "https://github.com.evil.io/"), false);
  assert.equal(originMatches(["https://www.npmjs.com"], "https://npmjs.com/package/x"), true);
  assert.equal(originMatches(o, "chrome://newtab"), false);
});
