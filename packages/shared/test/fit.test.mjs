import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLiveValue, fillBrowserPlaceholders, parseFeed, shapeResponse } from "../dist/index.js";

// An Instagram-like profile feed: each post is big because of image/video variants and plumbing.
function igPost(i, pinned) {
  const variants = Array.from({ length: 8 }, (_, j) => ({ url: `https://scontent.cdninstagram.com/v/${"x".repeat(200)}${j}`, width: 1080 - j, height: 1350 - j }));
  return {
    node: {
      code: `C${i}abc`,
      pk: `3${i}000000000`,
      id: `3${i}000000000_787132`,
      taken_at: 1761955200 + i * 86400,
      media_type: 8,
      product_type: "carousel_container",
      caption: { text: `Post ${i} caption`, pk: "1", created_at: 1761955200 },
      like_count: 1000 + i,
      comment_count: 10 + i,
      timeline_pinned_user_ids: pinned ? ["787132"] : [],
      image_versions2: { candidates: variants },
      video_versions: variants,
      organic_tracking_token: "t".repeat(400),
      user: { username: "natgeo", pk: "787132", profile_pic_url: variants[0].url, friendship_status: { following: false } },
      carousel_media: Array.from({ length: 6 }, (_, j) => ({ id: `m${j}`, image_versions2: { candidates: variants }, media_type: 1, accessibility_caption: "y".repeat(2500), sharing_friction_info: { a: 1 }, commerciality_status: "x".repeat(800), usertags: { in: Array.from({ length: 6 }, () => ({ user: { username: "someone", pk: "1", full_name: "z".repeat(300) } })) } })),
    },
  };
}
const igBody = JSON.stringify({
  data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges: Array.from({ length: 12 }, (_, i) => igPost(i, i < 3)), page_info: { has_next_page: true } } },
  extensions: { all_video_dash_prefetch_representations: Array.from({ length: 50 }, () => ({ representations: "r".repeat(2000) })) },
});

test("a big Instagram feed keeps whole posts, readable fields, and fits the cap", () => {
  assert.ok(igBody.length > 100_000);
  const out = shapeResponse(igBody, "application/json", { maxChars: 20_000 });
  assert.ok(out.length <= 20_000, `length ${out.length}`);
  const edges = JSON.parse(out).data.xdt_api__v1__feed__user_timeline_graphql_connection.edges;
  const posts = edges.filter((e) => e.node);
  assert.ok(posts.length >= 8, `only ${posts.length} posts fit`);
  const p = posts[0].node;
  assert.equal(p.caption.text, "Post 0 caption");
  assert.equal(p.like_count, 1000);
  assert.equal(p.comment_count, 10);
  assert.equal(p.url, "https://www.instagram.com/p/C0abc/");
  assert.match(p.taken_at, /^2025-11-01T/);
  assert.equal(p.media_type, 8);
  assert.ok(!out.includes("image_versions2") && !out.includes("video_versions") && !out.includes("tracking_token"));
  assert.ok(!out.includes("all_video_dash_prefetch"));
  // Pinned posts are flagged, so "posts this week" can skip old pinned ones.
  assert.deepEqual(posts.map((e) => Boolean(e.node.pinned)).slice(0, 5), [true, true, true, false, false]);
});

test("when items don't all fit, the list is cut by whole items with a note", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ title: `Item ${i}`, body: "b".repeat(300) }));
  const out = shapeResponse(JSON.stringify({ items }), "application/json", { maxChars: 5000 });
  const parsed = JSON.parse(out); // valid JSON, never cut mid-string
  const note = parsed.items.at(-1);
  assert.match(note._anymcp, /^showing \d+ of 200 items/);
  assert.ok(parsed.items.length > 5);
  assert.ok(out.length <= 5000);
});

test("small responses are returned unchanged", () => {
  const body = JSON.stringify({ a: [{ image_versions2: { x: 1 } }, { b: 2 }] });
  assert.equal(shapeResponse(body, "application/json", { maxChars: 1000 }), body);
});

test("Instagram relay provider flags default to off", () => {
  assert.equal(deriveLiveValue("__relay_internal__pv__PolarisFeedShareMenurelayprovider", {}), "false");
  assert.equal(deriveLiveValue("something_else", {}), undefined);
});

test("JSON text in a form field is filled key by key; true/false go in as JSON values", () => {
  const variables = JSON.stringify({ username: "natgeo", __relay_internal__pv__A: "{$live:__relay_internal__pv__A}", other: "{$live:missing}" });
  const req = { method: "POST", url: "https://www.instagram.com/graphql/query", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ doc_id: "1", variables }).toString() };
  const { request, missing } = fillBrowserPlaceholders(req, { "live:__relay_internal__pv__A": "false" });
  const v = JSON.parse(new URLSearchParams(request.body).get("variables"));
  assert.deepEqual(v, { username: "natgeo", __relay_internal__pv__A: false }); // only the missing key is dropped
  assert.deepEqual(missing, ["live:missing"]);
});

test("keepMissing leaves unfilled placeholders in place for a second pass", () => {
  const req = { method: "GET", url: "https://x.example/a?t={$live:tok}&u=1", headers: {} };
  const { request } = fillBrowserPlaceholders(req, {}, { keepMissing: true });
  assert.equal(new URL(request.url).searchParams.get("t"), "{$live:tok}");
});

test("Gmail's unread Atom feed becomes compact entries", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for me@example.com</title><tagline>New messages in your Gmail Inbox</tagline><fullcount>37</fullcount>
<entry><title>Invoice &amp; receipt</title><summary>Thanks for your order</summary><link rel="alternate" href="https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1&amp;view=conv" type="text/html" /><modified>2026-11-05T10:00:00Z</modified><issued>2026-11-05T10:00:00Z</issued><author><name>Shop</name><email>shop@example.com</email></author></entry>
<entry><title>Hello</title><summary>Hi there</summary><issued>2026-11-04T09:00:00Z</issued><author><name>Ann</name><email>ann@example.com</email></author></entry></feed>`;
  const out = JSON.parse(shapeResponse(xml, "application/atom+xml", undefined));
  assert.equal(out.count, 37);
  assert.equal(out.entries.length, 2);
  assert.deepEqual(out.entries[0], { title: "Invoice & receipt", from: "Shop", email: "shop@example.com", summary: "Thanks for your order", date: "2026-11-05T10:00:00Z", link: "https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1&amp;view=conv" });
  assert.deepEqual(parseFeed(xml).entries[1].from, "Ann");
});
