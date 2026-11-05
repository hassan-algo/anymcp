import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadLib, makeHome, publicProfile, sessionProfile } from "./helpers.mjs";

const lib = await loadLib();

async function setup(opts) {
  const h = await makeHome(opts);
  process.env.ANYMCP_HOME = h.home;
  const paths = lib.getPaths();
  const logs = [];
  const catalog = new lib.Catalog(paths, (m) => logs.push(m), h.bundled);
  catalog.reload();
  return { ...h, paths, catalog, logs };
}

test("merges bundled and local profiles and skips invalid ones", async () => {
  const { catalog, logs } = await setup();
  assert.deepEqual(catalog.all().map((e) => [e.profile.id, e.source]), [["example.com", "local"], ["weather.test", "bundled"]]);
  assert.ok(logs.some((l) => l.includes("Skipping an invalid bundled profile")));
});

test("local profiles override registry ones with the same id", async () => {
  const mine = { ...publicProfile, name: "My Weather" };
  const { catalog } = await setup({ localProfiles: [mine] });
  const e = catalog.get("weather.test");
  assert.equal(e.source, "local");
  assert.equal(e.profile.name, "My Weather");
});

test("search ranks matching tools and filters by category", async () => {
  const { catalog } = await setup();
  const hits = catalog.search("weather forecast for paris");
  assert.equal(hits[0].id, "weather.test/forecast");
  assert.equal(hits[0].auth, "none");
  assert.equal(catalog.search("item").length, 2);
  assert.equal(catalog.search("item", { category: "travel" }).length, 0);
  assert.equal(catalog.search("zzzz").length, 0);
});

test("categories, lists and pins", async () => {
  const { catalog } = await setup();
  const dev = catalog.categories().find((c) => c.id === "dev");
  assert.equal(dev.profiles, 1);
  assert.equal(catalog.inCategory("travel")[0].profile.id, "weather.test");
  assert.deepEqual(catalog.expandPin("list:starter"), ["weather.test/forecast"]);
  assert.deepEqual(catalog.expandPin("example.com"), ["example.com/get_item", "example.com/create_item"]);
  assert.ok(catalog.pinTargetExists("example.com/get_item"));
  assert.ok(!catalog.pinTargetExists("list:nope"));
});

test("save and delete local profiles; overview matches by origin", async () => {
  const { catalog, paths } = await setup({ localProfiles: [] });
  assert.throws(() => catalog.saveLocal({ id: "bad" }), /Invalid profile/);
  catalog.saveLocal(sessionProfile);
  assert.ok(fs.existsSync(path.join(paths.profilesDir, "example.com.json")));
  const ov = catalog.overview("https://www.example.com/page", { approvals: {}, pinned: [] }, { gatewayVersion: "x" });
  assert.deepEqual(ov.matching.map((m) => m.id), ["example.com"]);
  assert.equal(ov.local.length, 1);
  assert.ok(catalog.deleteLocal("example.com"));
  assert.equal(catalog.get("example.com"), undefined);
});

test("remote sync failure doesn't throw", async () => {
  const { catalog } = await setup();
  const r = await catalog.syncRemote("http://127.0.0.1:1/index.json", true);
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not download/);
});
