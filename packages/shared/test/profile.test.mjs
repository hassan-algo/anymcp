import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileSchema, validateProfile, effectiveAuth, hostOfTemplate } from "../dist/index.js";

function profile(overrides = {}, tool = {}) {
  return {
    schemaVersion: 1,
    id: "example.com",
    name: "Example",
    description: "An example profile for tests.",
    version: "1.0.0",
    authors: ["test"],
    categories: ["dev"],
    origins: ["https://example.com"],
    auth: "none",
    allowedHosts: ["api.example.com"],
    tools: [
      {
        name: "get_thing",
        title: "Get thing",
        description: "Gets a thing by id.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        mutates: false,
        action: { kind: "http", method: "GET", url: "https://api.example.com/things/{id}" },
        ...tool,
      },
    ],
    ...overrides,
  };
}

const errors = (p) => {
  const r = validateProfile(p);
  return r.ok ? [] : r.errors;
};

test("a valid profile passes", () => {
  assert.deepEqual(errors(profile()), []);
});

test("request hosts must be in allowedHosts", () => {
  const e = errors(profile({}, { action: { kind: "http", method: "GET", url: "https://evil.example/x" } }));
  assert.ok(e.some((x) => x.includes('"evil.example" is not in allowedHosts')), e.join("\n"));
});

test("form and webmcp pages are host-checked too", () => {
  const form = {
    kind: "form",
    page: "https://other.example/search",
    form: "form",
    fields: { id: "input[name=q]" },
  };
  assert.ok(errors(profile({}, { action: form })).some((x) => x.includes("not in allowedHosts")));
  const web = { kind: "webmcp", page: "https://other.example/", tool: "x" };
  assert.ok(errors(profile({}, { action: web })).some((x) => x.includes("not in allowedHosts")));
});

test("the host part of a URL can't be a template", () => {
  const e = errors(profile({ allowedHosts: ["{sub}.example.com"] }, { action: { kind: "http", method: "GET", url: "https://{sub}.example.com/x" } }));
  assert.ok(e.some((x) => x.includes("can't be a template")), e.join("\n"));
});

test("duplicate tool names are rejected", () => {
  const p = profile();
  p.tools.push({ ...p.tools[0] });
  assert.ok(errors(p).some((x) => x.includes('duplicate tool name "get_thing"')));
});

test("tool names must be snake_case", () => {
  assert.ok(errors(profile({}, { name: "GetThing" })).some((x) => x.includes("snake_case")));
});

test("{$cookie:} headers only work for browser-session tools", () => {
  const action = {
    kind: "http",
    method: "POST",
    url: "https://api.example.com/things",
    headers: { "x-csrf-token": "{$cookie:csrf}" },
  };
  assert.ok(errors(profile({}, { action })).some((x) => x.includes("only work for browser-session")));
  assert.deepEqual(errors(profile({ auth: "browser-session" }, { action })), []);
  assert.deepEqual(errors(profile({}, { action, auth: "browser-session" })), []);
});

test("required arguments must be defined properties", () => {
  const input = { type: "object", properties: {}, required: ["id"] };
  assert.ok(errors(profile({}, { input, action: { kind: "http", method: "GET", url: "https://api.example.com/x" } })).some((x) => x.includes('"id" is required but not defined')));
});

test("form fields must be input properties", () => {
  const action = { kind: "form", page: "https://api.example.com/s", form: "form", fields: { q: "input" } };
  assert.ok(errors(profile({}, { action })).some((x) => x.includes('field "q" is not an input property')));
});

test("origins are bare https origins", () => {
  assert.ok(errors(profile({ origins: ["https://example.com/path"] })).length > 0);
  assert.ok(errors(profile({ origins: ["http://example.com"] })).length > 0);
});

test("effectiveAuth: forms and webmcp always need the browser", () => {
  const p = ProfileSchema.parse(profile());
  assert.equal(effectiveAuth(p, p.tools[0]), "none");
  const form = { ...p.tools[0], action: { kind: "form", page: "https://api.example.com/", form: "f", fields: {} } };
  assert.equal(effectiveAuth(p, form), "browser-session");
  assert.equal(effectiveAuth(p, { ...p.tools[0], auth: "browser-session" }), "browser-session");
});

test("hostOfTemplate", () => {
  assert.equal(hostOfTemplate("https://api.example.com/a/{b}?c={d}"), "api.example.com");
  assert.equal(hostOfTemplate("https://{x}.example.com/"), "{x}.example.com");
  assert.equal(hostOfTemplate("not a url"), undefined);
});
