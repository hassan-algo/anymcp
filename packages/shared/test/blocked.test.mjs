import { test } from "node:test";
import assert from "node:assert/strict";
import { looksBlocked, retryAfterMs } from "../dist/index.js";

test("HTTP 429 is a block", () => {
  assert.match(looksBlocked({ status: 429, url: "https://x.com/i/api", body: "" }), /429/);
});

test("security check pages are blocks", () => {
  assert.ok(looksBlocked({ status: 200, url: "https://www.instagram.com/challenge/?next=/", body: "" }));
  assert.ok(looksBlocked({ status: 200, url: "https://www.facebook.com/checkpoint/1501092823525282/", body: "" }));
  assert.ok(looksBlocked({ status: 200, url: "https://www.google.com/sorry/index?continue=x", body: "" }));
  assert.equal(looksBlocked({ status: 200, url: "https://example.com/blog/challenges-of-scale", body: "" }), undefined);
});

test("Instagram action blocks and rate-limit errors in JSON", () => {
  assert.ok(looksBlocked({ status: 400, url: "https://i.instagram.com/api/v1/x", body: '{"message":"feedback_required","spam":true}' }));
  assert.ok(looksBlocked({ status: 200, url: "https://x.com/i/api/graphql/a/b", body: '{"errors":[{"code":88,"message":"Rate limit exceeded"}]}' }));
});

test("captcha pages by their text, but not ordinary pages or HTML", () => {
  assert.ok(looksBlocked({ status: 200, url: "https://shop.example/", body: "Just a moment... Verify you are human", page: true }));
  assert.equal(looksBlocked({ status: 200, url: "https://news.example/", body: "How CAPTCHA works ".repeat(400), page: true }), undefined);
  assert.equal(looksBlocked({ status: 200, url: "https://a.example/", body: '<html><script src="recaptcha.js"></script> captcha</html>' }), undefined);
  assert.equal(looksBlocked({ status: 200, url: "https://a.example/", body: '{"items":[]}' }), undefined);
});

test("Retry-After in seconds or as a date", () => {
  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs(new Date(10_000 + 30_000).toUTCString(), 10_000), 30_000);
  assert.equal(retryAfterMs(undefined), undefined);
});
