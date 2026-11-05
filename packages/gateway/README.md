# anymcp-gateway

**One MCP install. Every website becomes a tool your AI can use**, signed in as you, in your own browser, with far fewer tokens.

This is the AnyMCP MCP server. Add it to your AI app once:

```sh
# Claude Code
claude mcp add anymcp -- npx -y anymcp-gateway
```

```json
// Claude Desktop (Settings → Developer → Edit Config) or Cursor (~/.cursor/mcp.json)
{
  "mcpServers": {
    "anymcp": { "command": "npx", "args": ["-y", "anymcp-gateway"] }
  }
}
```

Public tools (GitHub, npm, Hacker News, weather…) work right away. For sites you're signed in to, install the AnyMCP Chrome extension: it connects to this server automatically.

Then just ask: *"Top 5 stories on Hacker News right now"*, *"What has @natgeo posted on Instagram this week?"*, *"Send a message to @alex on Instagram saying I'm running late"*. Anything that posts, sends or deletes asks you first.

## Commands

```text
anymcp                     Run the MCP server (what your AI app launches)
anymcp stats               How many tokens AnyMCP has saved
anymcp pace                How AnyMCP paces each site, and any paused sites
anymcp server import       Move your other MCP servers behind AnyMCP
anymcp --help              Everything else
```

Needs Node.js 20 or later. Settings live in `~/.anymcp`.

Docs, examples and the Chrome extension: https://github.com/hassan-algo/anymcp

MIT license.
