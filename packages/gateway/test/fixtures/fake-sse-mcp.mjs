// An MCP server that only speaks the old SSE transport. Prints its port.
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"));
const { McpServer } = await import(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const { SSEServerTransport } = await import(require.resolve("@modelcontextprotocol/sdk/server/sse.js"));

const transports = new Map();
const httpServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/sse") {
    const server = new McpServer({ name: "old-sse", version: "1.0.0" });
    server.registerTool("ping", { description: "Answers pong (old SSE server).", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const t = new SSEServerTransport("/messages", res);
    transports.set(t.sessionId, t);
    res.on("close", () => transports.delete(t.sessionId));
    await server.connect(t);
    return;
  }
  if (req.method === "POST" && u.pathname === "/messages") {
    const t = transports.get(u.searchParams.get("sessionId"));
    if (!t) return res.writeHead(404).end();
    return t.handlePostMessage(req, res);
  }
  res.writeHead(405).end("SSE only");
});
httpServer.listen(0, "127.0.0.1", () => console.log(httpServer.address().port));
