import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExtension, makeHome, startGateway, text } from "./helpers.mjs";

const loggedOut = '{"errors":[{"message":"Unauthorized logged out query.","severity":"CRITICAL","code":1675002}]}';

test("a signed-out site tool asks the user to sign in, waits, and retries", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  let calls = 0;
  const asks = [];
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: {
      request_approval: async () => ({ choice: "always" }),
      ask_user: async (req) => (asks.push(req), await new Promise((r) => setTimeout(r, 300)), { choice: "I've signed in", cancelled: false }),
      run_http: async (p) => (++calls === 1
        ? { status: 200, url: p.request.url, contentType: "application/json", body: loggedOut }
        : { status: 200, url: p.request.url, contentType: "application/json", body: '{"item":{"name":"Cup"}}' }),
    },
  });
  t.after(() => ext.close());
  const r = await client.callTool({ name: "call_tool", arguments: { id: "example.com/get_item", args: { id: "1" } } });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Cup/);
  assert.equal(calls, 2, "retried after sign-in");
  assert.equal(asks.length, 1);
  assert.match(asks[0].title, /Sign in to example\.com/);
  assert.deepEqual(asks[0].choices, ["I've signed in", "Cancel"]);
  assert.ok(asks[0].openUrl.startsWith("https://example.com"));
});

test("if the user cancels signing in, the result says so and tells the AI to ask", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: {
      request_approval: async () => ({ choice: "always" }),
      ask_user: async () => ({ choice: "Cancel", cancelled: true }),
      run_http: async (p) => ({ status: 200, url: p.request.url, contentType: "application/json", body: loggedOut }),
    },
  });
  t.after(() => ext.close());
  const r = await client.callTool({ name: "call_tool", arguments: { id: "example.com/get_item", args: { id: "1" } } });
  assert.ok(r.isError);
  assert.match(text(r), /signed out of Example.*ask_user/s);
});

test("ask_user returns the user's choice and text; navigate waits for sign-in", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const navs = [];
  const ext = await fakeExtension({
    port: h.port,
    token: h.token,
    handlers: {
      ask_user: async (req) => (req.input ? { choice: req.choices[0], text: "sam.lee", cancelled: false } : { choice: "I've signed in", cancelled: false }),
      navigate: async (p) => {
        navs.push(p.url);
        const url = navs.length === 1 ? `https://www.instagram.com/accounts/login/?next=${encodeURIComponent(p.url)}` : p.url;
        return { id: 9, windowId: 1, title: "Instagram", url, active: true };
      },
    },
  });
  t.after(() => ext.close());
  const a = text(await client.callTool({ name: "ask_user", arguments: { question: "Which Sam?", choices: ["Send", "Cancel"], text_input: "Sam's username" } }));
  assert.match(a, /The user chose "Send" and answered: "sam\.lee"/);
  const n = text(await client.callTool({ name: "navigate", arguments: { url: "https://www.instagram.com/direct/inbox/" } }));
  assert.deepEqual(navs, ["https://www.instagram.com/direct/inbox/", "https://www.instagram.com/direct/inbox/"]);
  assert.match(n, /Tab 9: https:\/\/www\.instagram\.com\/direct\/inbox\//);
});

test("without the extension or app prompts, ask_user says to ask in chat", async (t) => {
  const h = await makeHome();
  const { client } = await startGateway(h.env);
  t.after(() => client.close());
  const r = await client.callTool({ name: "ask_user", arguments: { question: "Proceed?" } });
  assert.ok(r.isError);
  assert.match(text(r), /Ask the user in chat/);
});
