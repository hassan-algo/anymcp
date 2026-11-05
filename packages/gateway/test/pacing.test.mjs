import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLib, makeHome } from "./helpers.mjs";

const lib = await loadLib();

/** A pacer on a fake clock: sleeping moves the clock instead of waiting. */
async function setup() {
  const h = await makeHome();
  process.env.ANYMCP_HOME = h.home;
  const paths = lib.getPaths();
  const clock = { t: Date.UTC(2026, 10, 5, 12) };
  const slept = [];
  const pacer = new lib.Pacer({
    paths,
    now: () => clock.t,
    sleep: async (ms) => {
      slept.push(ms);
      clock.t += ms;
    },
    random: () => 0.5,
  });
  return { pacer, clock, slept, paths };
}

const IG = "https://www.instagram.com/api/v1/users/web_profile_info/";

test("sites get the right pace", () => {
  assert.equal(lib.siteKey("https://i.instagram.com/x"), "instagram.com");
  assert.equal(lib.siteKey("https://www.bbc.co.uk/news"), "bbc.co.uk");
  assert.equal(lib.defaultPace("instagram.com", "browser-session"), "strict");
  assert.equal(lib.defaultPace("amazon.de", "browser-session"), "strict");
  assert.equal(lib.defaultPace("example.com", "browser-session"), "normal");
  assert.equal(lib.defaultPace("open-meteo.com", "none"), "relaxed");
  assert.equal(lib.defaultPace("open-meteo.com", "none", "strict"), "strict", "a profile can ask for more care");
  assert.equal(lib.defaultPace("instagram.com", "browser-session", "relaxed"), "strict", "but never less");
});

test("calls to a strict site are spaced out", async () => {
  const { pacer, slept } = await setup();
  await pacer.before(IG, { auth: "browser-session" });
  assert.equal(slept.length, 0, "the first call goes straight away");
  await pacer.before(IG, { auth: "browser-session" });
  assert.equal(slept.reduce((a, b) => a + b, 0), 5_500, "then a gap of 3-8 s");
});

test("actions that change data wait much longer and are capped per day", async () => {
  const { pacer, clock, slept } = await setup();
  await pacer.before(IG, { auth: "browser-session", acts: true });
  clock.t += 10_000;
  await pacer.before(IG, { auth: "browser-session", acts: true });
  assert.equal(slept.reduce((a, b) => a + b, 0), 42_500, "30-75 s between actions (52.5 s here, 10 s already passed)");

  const { pacer: p2, clock: c2 } = await setup();
  for (let i = 0; i < lib.LIMITS.strict.actsPerDay; i++) {
    await p2.before(IG, { auth: "browser-session", acts: true });
    c2.t += (2 * 60 * 60_000) / lib.LIMITS.strict.actsPerHour; // stay under the hourly cap
  }
  await assert.rejects(p2.before(IG, { auth: "browser-session", acts: true }), /most it does in a day/);
  await p2.before(IG, { auth: "browser-session" }); // reading still works
});

test("the hourly cap on actions stops bursts", async () => {
  const { pacer } = await setup();
  for (let i = 0; i < lib.LIMITS.strict.actsPerHour; i++) await pacer.before(IG, { auth: "browser-session", acts: true });
  await assert.rejects(pacer.before(IG, { auth: "browser-session", acts: true }), /in the last hour/);
});

test("a 429 pauses the site, and the pause grows", async () => {
  const { pacer, clock, paths } = await setup();
  await pacer.before(IG, { auth: "browser-session" });
  const note = pacer.after(IG, { blocked: "the site said there were too many requests (HTTP 429)", ok: false });
  assert.match(note, /paused instagram.com/);
  assert.match(note, /15 minutes/);
  await assert.rejects(pacer.before(IG, { auth: "browser-session" }), /paused instagram.com/);
  await assert.rejects(pacer.before("https://www.instagram.com/natgeo/", { auth: "browser-session" }), /paused/, "the whole site");
  clock.t += 16 * 60_000;
  await pacer.before(IG, { auth: "browser-session" });
  assert.match(pacer.after(IG, { blocked: "captcha", ok: true }), /60 minutes/, "second strike: an hour");
  lib.resumeSite(paths, "instagram.com");
  await pacer.before(IG, { auth: "browser-session" });
});

test("Retry-After is respected", async () => {
  const { pacer } = await setup();
  const note = pacer.after(IG, { blocked: "429", ok: false, retryAfterMs: 3 * 60 * 60_000 });
  assert.match(note, /3 hours/);
});

test("failed calls in a row pause the site briefly", async () => {
  const { pacer } = await setup();
  for (let i = 0; i < 3; i++) assert.equal(pacer.after(IG, { ok: false }), undefined);
  assert.match(pacer.after(IG, { ok: false }), /in a row failed/);
});

test("the user's pace wins, and off skips waits", async () => {
  const { pacer, slept, paths } = await setup();
  lib.setPace(paths, "instagram.com", "off");
  for (let i = 0; i < 20; i++) await pacer.before(IG, { auth: "browser-session", acts: true });
  assert.equal(slept.length, 0);
  assert.equal(pacer.status()[0].pace, "off");
});

test("the per-minute cap makes the next call wait for the window", async () => {
  const { pacer, slept } = await setup();
  for (let i = 0; i < lib.LIMITS.strict.perMinute; i++) await pacer.before(IG, { auth: "browser-session" });
  const before = slept.reduce((a, b) => a + b, 0); // 7 gaps of 5.5 s = 38.5 s
  await pacer.before(IG, { auth: "browser-session" });
  assert.equal(slept.reduce((a, b) => a + b, 0) - before, 60_000 - before, "waits until a minute after the first call");
});

test("executor: a 429 from a site pauses it and later calls don't reach it", async () => {
  const h = await makeHome();
  process.env.ANYMCP_HOME = h.home;
  const paths = lib.getPaths();
  const catalog = new lib.Catalog(paths, () => undefined, h.bundled);
  catalog.reload();
  let fetches = 0;
  const executor = new lib.Executor({
    catalog,
    approvals: new lib.Approvals(paths, async () => "always"),
    version: "test",
    browser: { connected: false, call: async () => assert.fail("no browser") },
    pacer: new lib.Pacer({ paths, sleep: async () => {} }),
    fetch: async (url) => {
      fetches++;
      return new Response("slow down", { status: 429, headers: { "retry-after": "600" } });
    },
  });
  const r = await executor.callTool("weather.test/forecast", { city: "Paris" });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /paused weather.test until .* \(10 minutes\)/);
  const again = await executor.callTool("weather.test/forecast", { city: "Rome" });
  assert.ok(again.isError);
  assert.match(again.content[0].text, /paused/);
  assert.equal(fetches, 1, "the second call never reached the site");
});
