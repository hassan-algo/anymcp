import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeExtension, makeHome, startGateway, text } from "./helpers.mjs";

const OFFICIAL = "chrome-extension://lakpncfioijpankpckjhpmpielbempik";
const within = (p, ms) => Promise.race([p.then(() => "connected"), new Promise((r) => setTimeout(() => r("rejected"), ms))]);

test("the official extension pairs without a token; other extensions still need it", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  await client.listTools();
  const official = await fakeExtension({ port: h.port, token: "", handlers: {}, origin: OFFICIAL });
  t.after(() => official.close());
  assert.ok(official.ws.readyState === 1);
  const other = fakeExtension({ port: h.port, token: "", handlers: {}, origin: "chrome-extension://someotherextensionid" });
  assert.equal(await within(other, 1500), "rejected");
  const withToken = await fakeExtension({ port: h.port, token: h.token, handlers: {}, origin: "chrome-extension://someotherextensionid" });
  withToken.close();
});

test("scan_site adds what the page offers, once", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const formTool = {
    name: "search",
    title: "Search",
    description: "Fills and submits the search form on https://shop.test/.",
    input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    mutates: false,
    action: { kind: "form", page: "https://shop.test/", form: "#search", fields: { q: "input[name=q]" } },
  };
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: { scan_tab: async () => ({ url: "https://shop.test/", tools: [formTool], allowedHosts: ["shop.test"], notes: ["Found 1 form."] }) },
  });
  t.after(() => ext.close());
  const r1 = text(await client.callTool({ name: "scan_site", arguments: {} }));
  assert.match(r1, /Added 2 tool\(s\): shop\.test\/open_path, shop\.test\/search/);
  const r2 = text(await client.callTool({ name: "scan_site", arguments: {} }));
  assert.match(r2, /Nothing new/);
});

test("remove_tools deletes the user's own tools but not registry ones", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const r = text(await client.callTool({ name: "remove_tools", arguments: { ids: ["example.com/create_item", "weather.test/forecast", "nope.test"] } }));
  assert.match(r, /Removed 1 tool\(s\) from example\.com/);
  assert.match(r, /weather\.test\/forecast: comes from the community registry/);
  assert.match(r, /nope\.test: not found/);
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, "profiles", "example.com.json"), "utf8"));
  assert.ok(!saved.tools.some((x) => x.name === "create_item"));
  const all = text(await client.callTool({ name: "remove_tools", arguments: { ids: ["example.com"] } }));
  assert.match(all, /Deleted example\.com/);
  assert.ok(!fs.existsSync(path.join(h.home, "profiles", "example.com.json")));
});

test("share_profile checks for personal data and gives a pull request link", async (t) => {
  const h = await makeHome();
  const cfg = path.join(h.home, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), registryRepo: "me/anymcp" }));
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const r = text(await client.callTool({ name: "share_profile", arguments: { site: "example.com" } }));
  assert.match(r, /no blocking personal data/);
  assert.match(r, /https:\/\/github\.com\/me\/anymcp\/new\/main\?filename=registry%2Fsites%2Fexample\.com%2Fprofile\.json&value=/);
  assert.ok(fs.existsSync(path.join(h.home, "share", "example.com.json")));

  // A profile with a hard-coded login token is refused.
  const p = JSON.parse(fs.readFileSync(path.join(h.home, "profiles", "example.com.json"), "utf8"));
  p.tools[0].action.headers = { authorization: "Bearer abcdefghijklmnop1234567890" };
  fs.writeFileSync(path.join(h.home, "profiles", "example.com.json"), JSON.stringify(p));
  await new Promise((r) => setTimeout(r, 1500));
  const bad = await client.callTool({ name: "share_profile", arguments: { site: "example.com" } });
  assert.ok(bad.isError);
  assert.match(text(bad), /Not ready to share/);
  const reg = await client.callTool({ name: "share_profile", arguments: { site: "weather.test" } });
  assert.match(text(reg), /already in the community registry/);
});
