# AnyMCP plan

**One MCP install for your AI. Every website becomes a set of tools.**

You add AnyMCP to your AI client once (Claude Desktop, Claude Code, Cursor…). From then on the AI can
search, browse by category or curated list, and call tools for any site that has a profile in the
community registry. Tools that need your login run in your own browser tab through the AnyMCP
extension; public tools run directly from the gateway.

```
AI client ──stdio──▶ AnyMCP gateway (npx -y anymcp-gateway, one install)
                       ├─ registry index (cached locally, synced from GitHub)
                       ├─ public tools (auth: none) ─────▶ run directly from the gateway
                       └─ logged-in tools ──WebSocket──▶ browser extension ▶ your tab
```

## Pieces

| Package | What it is |
|---|---|
| `packages/gateway` | The MCP server people install. Talks MCP over stdio, talks to the extension over a local WebSocket (`127.0.0.1`, pairing token, `chrome-extension://` origins only). |
| `packages/extension` | Chrome MV3 extension. Runs tools inside real tabs, records sites to generate tools, side panel for review/approval. |
| `packages/shared` | Wire protocol types and the **site profile** schema. |
| `registry/` | Community profiles, categories and lists (will move to its own repo once it grows). |

## Site profiles (the unit of sharing)

A profile is **plain JSON, never code**. It lists a site's tools: name, description, input JSON Schema,
whether it changes data (`mutates`), and how to run it (`http` request template or `form` fill).
Because it's data, installing someone else's profile can't run their code. Schema:
`packages/shared/src/profile.ts`. Example: `registry/sites/news.ycombinator.com/profile.json`.

Rules enforced by the schema:
- Every request host must be listed in `allowedHosts`.
- Tool names are unique, `snake_case`.
- `auth: "browser-session"` tools only run through the extension.

## What the AI sees: meta-tools

Instead of hundreds of tools (context bloat; Cursor caps at ~40), the gateway exposes a small fixed set:

| Tool | Purpose |
|---|---|
| `search_tools(query, category?)` | Find tools across the registry |
| `list_categories()` | Shopping, Dev, Productivity, Travel, Finance, News, Social… |
| `browse(category \| list)` | Sites and tools in a category or curated list |
| `describe_tool(id)` | Full input schema, loaded on demand |
| `call_tool(id, args)` | Run it |
| `pin(site \| list)` | Promote frequent tools to first-class tools (`tools/list_changed`) |

Plus generic browser tools that work everywhere: `list_tabs`, `read_page`, later `click`, `fill`,
`navigate`, `screenshot`.

## Where tools come from

1. **Hand-written profiles** in the registry (bootstrap with ~10).
2. **Generated** by the extension: WebMCP (`navigator.modelContext`), OpenAPI/GraphQL discovery,
   `<form>` → tool, and **recording mode** (watch the site's JSON API calls, infer endpoints/params).
3. **Reviewed** by the user in the side panel, then optionally **published** to the registry.

## Registry

- Phase 1: GitHub repo. Publish = pull request from the extension. CI validates the schema, rejects code,
  secrets and off-domain requests. A generated `index.json` is what clients sync.
- Phase 2: website with search, install counts, ratings, "broken" reports, verified publishers.
- Site owners can claim a domain via `/.well-known/anymcp.json` (marks a profile as official).
- Profiles are versioned; updates show a diff and need approval.

## Safety

- First use of a site needs approval; anything with `mutates: true` asks every time unless "always allow".
- **Publishing strips personal data** (IDs, tokens, emails) into parameters and shows a preview. Biggest risk.
- Cookies/tokens are never exposed through tools.
- Page content is returned wrapped as untrusted, so injected text isn't treated as instructions.

## Milestones

| # | Milestone | Status |
|---|---|---|
| M0 | Spike: gateway ↔ extension, `list_tabs` + `read_page` | done |
| M1 | Profile format v1, categories and lists, registry validator | done: schema, validator, 11 profiles, 4 lists, 8 categories, generated `index.json` |
| M2 | Gateway meta-tools (`search`, `browse`, `describe`, `call`) over hand-written profiles | done, tested end to end |
| M3 | Public tools run in the gateway; logged-in tools run via the extension | done, tested end to end |
| M4 | GitHub registry, index sync, curated lists | built; the public GitHub repo isn't created yet (see docs/publishing.md) |
| M5 | Tool generation: forms, WebMCP/OpenAPI, recording mode (incl. persisted GraphQL, page visits, live session values) | done; recording any site: built, see below |
| M6 | Publish flow with personal-data stripping, CI checks | built: privacy scan in shared, PR checks in `.github/workflows/registry.yml` |
| M7 | Pinning, approval prompts, side panel | done, tested end to end |
| M8 | Ship (Chrome Web Store, `npx -y anymcp-gateway`), then the registry website | gateway published on npm (`anymcp-gateway` 0.1.0); Chrome Web Store not yet; registry website not started |

## Recording any site (built)

The recorder turns what a site does into tools, for almost any site:
- REST/JSON calls, standard GraphQL, and persisted GraphQL (Facebook/Instagram/Threads `doc_id`, X `/graphql/<id>/<Name>`, Apollo `operationName`): one tool per action, real inputs only, harmless constants as defaults.
- Page visits become `page` tools for sites without an API.
- Session and anti-forgery codes become `{$live:…}` / `{$cookie:…}` / `{$meta:…}` placeholders that the browser fills at call time from the page's own latest request, known page patterns, hidden inputs, meta tags or cookies. Never stored.
- Noise is filtered: analytics, logging endpoints and file servers (CDNs).

## Known risks / open items

- MV3 service workers sleep: kept alive by WebSocket pings (Chrome 116+) plus a `chrome.alarms` reconnect.
- Several AI clients at once: the first gateway owns the port, the others connect to it and forward browser
  calls; if the first one exits, another takes over within a few seconds.
- Recording uses in-page fetch/XHR patching (no `chrome.debugger`), so requests made before recording
  starts, from service workers, or over WebSockets aren't captured.
- Site access is per site (optional host permissions). Screenshots need "Allow on all sites".
- WebMCP support is experimental; the API is still changing.
- The npm name `anymcp` belongs to an unrelated package, so this one publishes as `anymcp-gateway`.
- Recorded tools can still fail on sites that sign each request with in-page code, talk only over WebSockets, block automation or show CAPTCHAs. The browser tools (`read_page`, `click`, `fill`…) are the fallback.
- `{$live:…}` values come from the page's own recent requests, so a site has to be open (or opened by AnyMCP in a background tab) and have made at least one request first.
- Not done yet: the Chrome Web Store listing and the registry website. Done: npm (`anymcp-gateway`), public GitHub repo (hassan-algo/anymcp).
