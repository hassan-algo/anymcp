import { test } from "node:test";
import assert from "node:assert/strict";
import { inferTools, toolsFromOpenApi, toolFromForm, ToolSchema, scanForPersonalData } from "../dist/index.js";

const json = "application/json";
const req = (method, url, extra = {}) => ({ method, url, status: 200, responseContentType: json, ...extra });
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));

// ---- infer.ts ---------------------------------------------------------------

test("ID-like path segments become required parameters", () => {
  const { tools } = inferTools([req("GET", "https://api.example.com/v1/issues/12345")]);
  assert.equal(tools.length, 1);
  const t = tools[0];
  assert.equal(t.name, "get_issue");
  assert.equal(t.action.url, "https://api.example.com/v1/issues/{issue_id}");
  assert.deepEqual(t.input.required, ["issue_id"]);
  assert.equal(t.mutates, false);
  assert.ok(ToolSchema.safeParse(t).success);
});

test("paths that differ in one segment are merged into a parameter", () => {
  const { tools } = inferTools([req("GET", "https://api.example.com/users/alice/repos"), req("GET", "https://api.example.com/users/bob/repos")]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].action.url, "https://api.example.com/users/{user_id}/repos");
  assert.equal(tools[0].name, "get_repos");
});

test("analytics, assets, failures and non-JSON pages are ignored", () => {
  const { tools } = inferTools([
    req("POST", "https://www.google-analytics.com/g/collect"),
    req("GET", "https://example.com/app.js"),
    req("GET", "https://api.example.com/things", { status: 500 }),
    req("GET", "https://example.com/about", { responseContentType: "text/html" }),
    req("GET", "http://api.example.com/insecure"),
    req("OPTIONS", "https://api.example.com/things"),
  ]);
  assert.deepEqual(tools, []);
});

test("token-like query params are filled by the browser; cache busters dropped silently", () => {
  const { tools, notes } = inferTools([req("GET", "https://api.example.com/search?q=cats&csrf_token=abc&_=123&utm_source=x&page=2")]);
  const t = tools[0];
  assert.equal(t.name, "search");
  assert.deepEqual(Object.keys(t.action.query).sort(), ["csrf_token", "page", "q"]);
  assert.equal(t.action.query.csrf_token, "{$live:csrf_token}");
  assert.equal(t.action.query.q, "{q}");
  assert.equal(t.input.properties.page.type, "number");
  assert.ok(notes.some((n) => n.includes("csrf_token")), notes.join("\n"));
  assert.equal(JSON.stringify(t).includes("cats"), false, "recorded values must not leak into the tool");
});

test("search endpoints and list endpoints get readable names", () => {
  const { tools } = inferTools([
    req("GET", "https://api.example.com/api/v2/products?q=shoes"),
    req("GET", "https://api.example.com/api/v2/search?query=x"),
  ]);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["search", "search_products"]);
});

test("POST/PATCH/DELETE get create/update/delete names and mutate", () => {
  const { tools } = inferTools([
    req("POST", "https://api.example.com/repos/acme/app/issues", { requestBody: '{"title":"Bug","labels":["x"],"count":2}', requestContentType: json }),
    req("PATCH", "https://api.example.com/issues/987654", { requestBody: '{"state":"closed"}', requestContentType: json }),
    req("DELETE", "https://api.example.com/issues/987654"),
  ]);
  const t = byName(tools);
  assert.ok(t.create_issue, Object.keys(t).join(","));
  assert.ok(t.update_issue);
  assert.ok(t.delete_issue);
  assert.equal(t.create_issue.mutates, true);
  assert.deepEqual(t.create_issue.action.body, { encoding: "json", value: { title: "{title}", labels: "{labels}", count: "{count}" } });
  assert.equal(t.create_issue.input.properties.labels.type, "array");
  assert.equal(t.create_issue.input.properties.count.type, "integer");
  assert.equal(JSON.stringify(t.create_issue).includes("Bug"), false);
});

test("form-encoded bodies become form parameters", () => {
  const { tools } = inferTools([
    req("POST", "https://example.com/comment", { requestBody: "text=hi&parent=1", requestContentType: "application/x-www-form-urlencoded" }),
  ]);
  assert.deepEqual(tools[0].action.body, { encoding: "form", value: { text: "{text}", parent: "{parent}" } });
});

test("GraphQL operations become one tool each, queries don't mutate", () => {
  const q = (op, query, variables) => req("POST", "https://example.com/graphql", { requestBody: JSON.stringify({ operationName: op, query, variables }), requestContentType: json });
  const { tools } = inferTools([
    q("SearchUsers", "query SearchUsers($term: String!) { users(term: $term) { id } }", { term: "bob" }),
    q("AddStar", "mutation AddStar($id: ID!) { addStar(id: $id) { ok } }", { id: "1" }),
  ]);
  const t = byName(tools);
  assert.ok(t.search_users, Object.keys(t).join(","));
  assert.ok(t.add_star);
  assert.equal(t.search_users.mutates, false);
  assert.equal(t.add_star.mutates, true);
  assert.deepEqual(t.search_users.action.body.value.variables, { term: "{term}" });
  assert.equal(t.search_users.action.body.value.operationName, "SearchUsers");
});

test("a single array field in the response becomes `pick`", () => {
  const { tools } = inferTools([req("GET", "https://api.example.com/things", { responseSample: '{"total":2,"items":[{"a":1}]}' })]);
  assert.equal(tools[0].action.response.pick, "items");
});

test("allowedHosts lists every host seen", () => {
  const { allowedHosts } = inferTools([req("GET", "https://a.example.com/x"), req("GET", "https://b.example.com/y")]);
  assert.deepEqual(allowedHosts.sort(), ["a.example.com", "b.example.com"]);
});

// ---- openapi.ts -------------------------------------------------------------

test("OpenAPI 3: $ref params, query, path and JSON body", () => {
  const doc = {
    openapi: "3.0.0",
    info: { title: "Pets", description: "Pet store" },
    servers: [{ url: "/api/{version}", variables: { version: { default: "v1" } } }],
    components: {
      parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer" } } },
      schemas: { Pet: { type: "object", required: ["name"], properties: { name: { type: "string" }, tag: { type: "string" } } } },
    },
    paths: {
      "/pets": {
        get: { operationId: "listPets", summary: "List all pets", parameters: [{ $ref: "#/components/parameters/Limit" }] },
        post: { operationId: "createPet", summary: "Create a pet", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } },
      },
      "/pets/{pet-id}": {
        get: { operationId: "showPetById", parameters: [{ name: "pet-id", in: "path", required: true, schema: { type: "string" } }, { name: "Authorization", in: "header" }] },
        delete: { deprecated: true },
      },
    },
  };
  const r = toolsFromOpenApi(doc, "https://pets.example.com/openapi.json");
  assert.equal(r.title, "Pets");
  assert.deepEqual(r.allowedHosts, ["pets.example.com"]);
  const t = byName(r.tools);
  assert.deepEqual(Object.keys(t).sort(), ["create_pet", "list_pets", "show_pet_by_id"]);
  assert.equal(t.list_pets.action.url, "https://pets.example.com/api/v1/pets");
  assert.deepEqual(t.list_pets.action.query, { limit: "{limit}" });
  assert.equal(t.list_pets.input.properties.limit.type, "integer");
  assert.deepEqual(t.create_pet.action.body, { encoding: "json", value: { name: "{name}", tag: "{tag}" } });
  assert.deepEqual(t.create_pet.input.required, ["name"]);
  assert.equal(t.create_pet.mutates, true);
  assert.equal(t.show_pet_by_id.action.url, "https://pets.example.com/api/v1/pets/{pet_id}");
  assert.equal(t.show_pet_by_id.action.headers, undefined, "Authorization headers are never copied");
  for (const tool of r.tools) assert.ok(ToolSchema.safeParse(tool).success, tool.name);
});

test("Swagger 2 with a body parameter", () => {
  const doc = {
    swagger: "2.0",
    host: "api.example.com",
    basePath: "/v2",
    schemes: ["https"],
    paths: { "/orders": { post: { summary: "Place order", parameters: [{ in: "body", name: "body", schema: { type: "object", properties: { qty: { type: "integer" } } } }] } } },
  };
  const r = toolsFromOpenApi(doc, "https://api.example.com/swagger.json");
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].action.url, "https://api.example.com/v2/orders");
  assert.deepEqual(r.tools[0].action.body.value, { qty: "{qty}" });
  assert.equal(r.tools[0].description, "Place order");
});

test("a non-HTTPS server gives no tools", () => {
  const r = toolsFromOpenApi({ openapi: "3.0.0", servers: [{ url: "http://insecure.example.com" }], paths: { "/x": { get: {} } } }, "http://insecure.example.com/openapi.json");
  assert.deepEqual(r.tools, []);
  assert.ok(r.notes.length);
});

// ---- forms.ts ---------------------------------------------------------------

test("a search form becomes a non-mutating search tool without the page's query string", () => {
  const t = toolFromForm({
    selector: "#search",
    pageUrl: "https://shop.example.com/products?session=abc#top",
    action: "https://shop.example.com/search",
    method: "get",
    fields: [
      { name: "q", selector: "input[name=q]", type: "search", label: "Search products", required: true },
      { name: "csrf", selector: "input[name=csrf]", type: "hidden", required: false },
      { name: "pw", selector: "input[name=pw]", type: "password", required: false },
      { name: "sort", selector: "select[name=sort]", type: "select", required: false, options: ["price", "new"] },
    ],
  });
  assert.equal(t.name, "search");
  assert.equal(t.mutates, false);
  assert.equal(t.action.page, "https://shop.example.com/products");
  assert.deepEqual(Object.keys(t.action.fields).sort(), ["q", "sort"]);
  assert.deepEqual(t.input.properties.sort.enum, ["price", "new"]);
  assert.deepEqual(t.input.required, ["q"]);
  assert.ok(ToolSchema.safeParse(t).success);
});

test("a POST form mutates; a form with no usable fields gives nothing", () => {
  const t = toolFromForm({ selector: "form", pageUrl: "https://x.example.com/c", action: "https://x.example.com/comment", method: "POST", fields: [{ name: "text", selector: "textarea", type: "textarea", required: true }] });
  assert.equal(t.name, "submit_comment");
  assert.equal(t.mutates, true);
  assert.equal(toolFromForm({ selector: "form", pageUrl: "https://x.example.com/", action: "", method: "POST", fields: [{ name: "t", selector: "i", type: "hidden", required: false }] }), undefined);
});

// ---- privacy.ts -------------------------------------------------------------

test("privacy: secrets block, emails warn, placeholders are fine", () => {
  const profile = {
    id: "x.example.com",
    description: "Contact me at someone@realmail.net",
    authors: ["me@realmail.net"],
    tools: [
      {
        name: "a",
        description: "Fine",
        action: {
          kind: "http",
          url: "https://api.example.com/users/{user_id}",
          headers: { authorization: "Bearer abcdefghijklmnop1234", "x-csrf-token": "{$cookie:csrf}", "x-ok": "{value}" },
          query: { jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig", account: "123e4567-e89b-12d3-a456-426614174000", key: "{key}" },
        },
      },
    ],
  };
  const f = scanForPersonalData(profile);
  const at = (p) => f.find((x) => x.path === p);
  assert.equal(at("tools[0].action.headers.authorization")?.severity, "block");
  assert.equal(at("tools[0].action.query.jwt")?.severity, "block");
  assert.equal(at("tools[0].action.query.account")?.severity, "warn");
  assert.equal(at("description")?.severity, "warn");
  assert.equal(at("tools[0].action.headers.x-csrf-token"), undefined);
  assert.equal(at("tools[0].action.headers.x-ok"), undefined);
  assert.equal(at("tools[0].action.url"), undefined);
  assert.equal(at("authors[0]"), undefined, "authors may list their own contact");
  assert.ok(!f.some((x) => x.value.includes("abcdefghijklmnop1234")), "values are masked");
});

test("privacy: the registry examples are clean", async () => {
  const fs = await import("node:fs");
  const dir = new URL("../../../registry/sites/", import.meta.url);
  for (const site of fs.readdirSync(dir)) {
    const p = JSON.parse(fs.readFileSync(new URL(`${site}/profile.json`, dir), "utf8"));
    assert.deepEqual(scanForPersonalData(p), [], site);
  }
});
