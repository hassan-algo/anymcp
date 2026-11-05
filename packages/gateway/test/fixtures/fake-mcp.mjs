// A small MCP server for tests, with bulky results like many real servers return.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"));
const { McpServer } = await import(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const { StdioServerTransport } = await import(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"));
const { z } = await import(require.resolve("zod"));

const server = new McpServer({ name: "fake-tracker", version: "1.0.0" }, { instructions: "A fake issue tracker for tests." });
const issue = (n) => ({ number: n, title: `Issue ${n}`, state: "open", body: null, labels: [], assignee: null, milestone: null, reactions: {}, url: `https://tracker.test/issues/${n}`, closed_at: null, comments: 0, draft: false });

server.registerTool(
  "list_issues",
  { description: "List open issues in the tracker.", inputSchema: { repo: z.string(), limit: z.number().optional() }, annotations: { readOnlyHint: true } },
  async ({ repo, limit }) => ({ content: [{ type: "text", text: JSON.stringify({ repo, items: Array.from({ length: limit ?? 30 }, (_, i) => issue(i + 1)), next: null }, null, 2) }] }),
);
server.registerTool(
  "createIssue",
  { description: "Create a new issue.", inputSchema: { repo: z.string(), title: z.string() } },
  async ({ title }) => ({ content: [{ type: "text", text: JSON.stringify(issue(99)).replace("Issue 99", title) }] }),
);
server.registerTool("pid", { description: "Which process answers (for tests).", inputSchema: {} }, async () => ({ content: [{ type: "text", text: String(process.pid) }] }));
server.registerTool(
  "confirm_delete",
  { description: "Delete a repo after asking the user to confirm.", inputSchema: { repo: z.string() } },
  async ({ repo }) => {
    const r = await server.server.elicitInput({
      message: `Really delete ${repo}?`,
      requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Delete it?" }, reason: { type: "string", title: "Why" } }, required: ["confirm"] },
    });
    return { content: [{ type: "text", text: JSON.stringify(r) }] };
  },
);
server.registerTool(
  "slow_confirm",
  { description: "Wait a moment, then ask the user to confirm.", inputSchema: { label: z.string() } },
  async ({ label }) => {
    await new Promise((r) => setTimeout(r, 700));
    const r = await server.server.elicitInput({ message: `Confirm ${label}?`, requestedSchema: { type: "object", properties: { reason: { type: "string" } } } });
    return { content: [{ type: "text", text: `${label}: ${r.content?.reason}` }] };
  },
);
server.registerTool(
  "summarize",
  { description: "Summarize a text using the client's model.", inputSchema: { text: z.string() } },
  async ({ text }) => {
    try {
      const r = await server.server.createMessage({ messages: [{ role: "user", content: { type: "text", text: `Summarize: ${text}` } }], maxTokens: 50 });
      return { content: [{ type: "text", text: `summary: ${r.content.text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `sampling failed: ${err.message}` }], isError: true };
    }
  },
);
server.registerTool("whoami", { description: "Who is signed in to the tracker.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "tester" }] }));

await server.connect(new StdioServerTransport());
