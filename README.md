<img src="assets/icon.svg" width="64" height="64" alt="">

# AnyMCP

**One MCP install for your AI. Every website becomes a set of tools, and in our measurements your AI used 93–95% fewer tokens to get the same answers.**

AnyMCP is an MCP server you add to your AI app once (Claude Code, Claude Desktop, Cursor…). From then on, your AI can use any website through small, direct tools instead of clicking through pages or loading dozens of separate MCP servers.

- **One install, every site.** Your AI searches a shared library of site tools (Hacker News, GitHub, npm, the weather, and sites you add) and loads only the one it needs.
- **It learns as your AI works.** When there's no tool for a task, your AI does it in the browser once. AnyMCP watches the requests the site makes and turns them into a tool, so next time it's one call instead of a dozen clicks.
- **It runs as you, in your own browser.** Signed-in sites work through your own Chrome tab. AnyMCP never sees or stores your cookies or passwords.
- **It sits in front of your other MCP servers too**, so their tool lists stop filling every conversation (see [Connect your other MCP servers](#connect-your-other-mcp-servers)).

## Token savings

Measured on real calls in November 2026, at about 4 characters per token.

| Where tokens go | Without AnyMCP | With AnyMCP | Saved |
|---|---|---|---|
| **Tool list in every conversation** (100 sites, 3 tools each) | ~28k | ~1.4k | **95%** |
| **API responses** (GitHub, npm, PyPI, Hacker News) | 160.4k | 8.9k | **94.5%** |
| **Reading a heavy page** (Product Hunt home page, HTML vs. text) | ~354k | ~1.5k | **99.6%** |

**One example session**, using the numbers above: an AI app with 100 sites' tools loaded, making those four API calls, would use about **188k tokens**. With AnyMCP it uses about **10k**, **94.5% less**. Across all 8 calls measured (the four above plus four small ones), AnyMCP sent 12.5k tokens of the 176k the sites returned: **93% less**.

### Why it saves so much

1. **The tool list stays small.** Most MCP setups put every tool's description into every conversation, about 95 tokens per tool. AnyMCP lists a dozen general tools, about 1.4k tokens, however many sites or servers you add. Your AI looks up a site's tool only when it needs it.
2. **Responses are trimmed.** Each site tool keeps only the fields that matter. Results from other MCP servers are compacted too: empty fields dropped, JSON minified, very long output capped.
3. **Clicking becomes one call.** Doing a task in the browser means many rounds of reading the page, finding a button and clicking. Once AnyMCP has learned the site's request, the same task is one `call_tool` with a small result. Tools repair themselves when sites change, so this keeps working.
4. **Pages come back as text.** When there's no data call to use, AnyMCP returns only the page's readable text, never the HTML.
5. **Learned tools are shared.** When someone shares a site's tools to the community library, everyone else gets the one-call version from the start.

### The biggest API responses, call by call

| Call | Site sent | AI received | Saved |
|---|---|---|---|
| PyPI package info | 48.2k | 0.1k | 99.8% |
| GitHub repository search | 40.6k | 2.4k | 94% |
| npm package search | 63.3k | 5.0k | 92% |
| Hacker News front page | 8.3k | 1.4k | 83% |

### Where it saves less

- **APIs that are already small.** A weather forecast or a Wikipedia summary is a few hundred tokens either way.
- **The first time on a new site.** The AI clicks through once, and that's how the tool gets learned.
- **Finding a tool takes a step or two** (`search_tools`, then `describe_tool`). Pin a site you use often to make its tools directly callable.
- **Page reads compared with a good web-fetch tool.** The 99.6% is against the raw HTML. A fetch tool that already converts pages to text gets similar text. AnyMCP counts these separately and doesn't include them in the API savings.

**See your own numbers:** ask your AI *"how many tokens has AnyMCP saved?"*, run `anymcp stats`, or open the extension's side panel.

## Install

You need Node.js 20+ and, for logged-in sites and browser tools, Chrome 116+.

### 1. Add AnyMCP to your AI app

**Claude Code**

```sh
claude mcp add anymcp -- npx -y anymcp-gateway
```

**Claude Desktop**: Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "anymcp": { "command": "npx", "args": ["-y", "anymcp-gateway"] }
  }
}
```

**Cursor**: add the same block to `~/.cursor/mcp.json`.

That's enough for public tools. Ask: *"What's the weather in Lisbon this weekend?"*

### 2. Install the browser extension

Until it's on the Chrome Web Store: run `npm run build` in this repo, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `packages/extension/dist`.

That's it: there's nothing to pair. The gateway recognizes the official extension by its fixed ID, which Chrome itself reports, so other extensions and websites can't pretend to be it. The side panel's dot turns green whenever an AI app that uses AnyMCP is open.

(Other Chromium browsers or your own builds get a different ID; for those, paste the token from `anymcp token` under Settings → Advanced.)

## How the AI uses it

AnyMCP gives the AI a few tools instead of hundreds, so it doesn't fill the AI's context:

| Tool | What it does |
|---|---|
| `search_tools` | Find tools across every site: *"flight prices"*, *"python package"* |
| `list_categories` | Developer, News, Reference, Travel, Finance… |
| `browse` | Show the sites and tools in a category or curated list |
| `describe_tool` | Get a tool's parameters, only when needed |
| `call_tool` | Run it |
| `pin` / `unpin` | Turn a site or list you use often into regular tools the AI can call directly |
| `ask_user` | Ask you something mid-task (a choice, yes/no, or a short answer) and wait for your reply, in a small browser window |
| `open_url` | Read any web page as text, in your signed-in browser (or fetched directly without the extension). Meant to replace the AI's generic web fetch: it counts the tokens saved and learns the site's data calls for next time |
| `add_site` | Open the setup window in Chrome for a site that has no tools yet, so you can record it |
| `scan_site` | Pick up tools the open page offers: its forms, the site's own WebMCP tools, an OpenAPI description, an official profile |
| `remove_tools` | Delete your own tools, e.g. learned ones that aren't useful |
| `share_profile` | Check a profile for personal data and get a link to submit it to the community registry |
| `token_savings` | How many tokens AnyMCP has saved so far |

Managing tools happens by asking your AI: *"remove the learned Instagram tools"*, *"share my instagram.com profile"*, *"how many tokens has AnyMCP saved?"*. The side panel only shows the current site's tools, a **Record this site** button, and settings.

Browser tools that work on any page: `list_tabs`, `read_page`, `find_elements`, `click`, `fill`, `navigate`, `screenshot`.

A typical call: `search_tools("weather")` → `describe_tool("open-meteo.com/get_forecast")` → `call_tool(...)`.

## Make tools for any site

Most of the time you don't need to do anything: your AI learns a site as it uses it (see below). To set one up yourself, ask your AI to *"add instagram.com"* (it calls `add_site`) or click **Record this site** in the side panel. A setup window opens:

1. **Open site**: you allow AnyMCP on that site and it opens in a tab.
2. AnyMCP shows what it already found (community tools, the site's own API description, forms) and asks whether you want to **record** how you use the site.
3. Use the site normally for a minute: open your profile, search, open an item. The window counts what it captures.
4. **Stop and make tools**, review the list, **Save tools**. Your AI can use them right away.

Your AI can also run `scan_site` on an open page to pick up its forms, the site's own WebMCP tools, an OpenAPI description, or an official profile the site publishes.

What recording captures:
  - **API calls**, including GraphQL and the "saved query" style big sites use: Facebook, Instagram and Threads (`doc_id`), X (`/graphql/<id>/<Name>`) and Apollo apps. You get one tool per action (`profile_page`, `search_timeline`, `create_tweet`…), and only the real inputs become parameters.
  - **Page visits**, for sites with no API. Visiting `/natgeo/` and `/nasa/` becomes an `open_page` tool that opens any profile and returns its text.
- You review the suggested tools in the setup window, untick ones you don't want, and save.

**The workflow your AI follows** (AnyMCP tells it this when it connects):
1. Look for a tool first (`search_tools`). If one fits, one `call_tool` does the job.
2. If there's no tool, the tool can't do this exact thing, or it fails, do the task in the browser. AnyMCP learns from it.
3. Next time the same kind of task comes up, use the tool it learned.

Tools also get better over time. When the AI's clicks do the same action as an existing tool, AnyMCP updates that tool: it picks up the site's new internal query ids (sites like Instagram change them often), adds inputs the site now sends, and rebuilds a tool that has failed in the last day from the request that just worked. The AI is told what changed.

**It learns as your AI works.** When there's no tool for something and the AI clicks through a site with the browser tools, AnyMCP watches the requests those clicks trigger (not the page's background traffic) and turns new ones into tools in your profile for that site. The AI is told on its next call, so the next time it's one `call_tool` instead of a dozen clicks and page reads. Any site the AI uses for the first time gets its own entry, even a plain site with no API: it gets an `open_path` tool ("open any page on this site and read it") plus whatever page tools with inputs it saw (a search page, a profile by name), so next time `search_tools` finds the site. If AnyMCP isn't allowed on that site yet, a small window asks you first. To drop learned tools, ask your AI (it calls `remove_tools`); turn learning off in the side panel's Settings. Background calls (ads, logging, promotions) and anything that hands out credentials are skipped. Ids the page invents per request (like a message's `offline_threading_id`) are generated fresh on every call, and when an id comes from a page address or another tool's result, the tool says so.

**Session codes.** Logged-in sites send login and anti-forgery codes with every request (CSRF tokens, Facebook's `fb_dtsg`, an `authorization` header). AnyMCP never saves them. A recorded tool marks them as `{$live:…}`, `{$cookie:…}` or `{$meta:…}`, and your browser fills them in each time the tool runs. If a value can't be found, the result says so: open the site in Chrome, signed in, use it for a moment, and try again.

**What still doesn't work well:**
- Sites that only talk over WebSockets (some chat and trading apps).
- Requests the page signs with fresh code on every call (some anti-bot systems); the recorded tool gets rejected.
- Sites that block automation, or ask for a CAPTCHA.
- Values that change on every request in ways the page computes itself. These usually show up in the result as "missing session values".

For these, the general browser tools (`read_page`, `find_elements`, `click`, `fill`, `navigate`) still work on any page.

## Connect your other MCP servers

AnyMCP can also sit in front of the other MCP servers you use (GitHub, filesystem, Notion…). Every server you add to your AI app normally puts all its tool definitions into every conversation; big ones cost tens of thousands of tokens before you ask anything. Behind AnyMCP their tools live in the catalog: the AI finds them with `search_tools`, loads one tool's details with `describe_tool`, and runs it with `call_tool`. Results are compacted (empty and null fields dropped, JSON minified, very long output capped) and counted in your token savings.

```sh
anymcp server import claude-code     # copy the servers you already use (also claude-desktop, cursor)
anymcp server add github --env GITHUB_PERSONAL_ACCESS_TOKEN=… -- npx -y @modelcontextprotocol/server-github
anymcp server add notion --url https://mcp.notion.com/mcp --header "Authorization=Bearer …"
anymcp server test github            # start it, list its tools, show the tokens kept out of context
anymcp server list
```

After importing, remove those servers from your AI app so their tools aren't loaded twice. Servers start the first time one of their tools is used, and their tool lists are cached. Tools that change data (by their own annotations, or names like `create_…`, `delete_…`) ask you first, like site tools. API keys you pass with `--env`/`--header` are stored only in `~/.anymcp/servers.json` (readable only by you).

**Servers that ask things mid-call work too.** When a server asks the user a question (elicitation), AnyMCP shows it in a small Chrome window (or your AI app's own prompt if the extension isn't connected) and passes the answer back. When a server asks for AI-generated text (sampling), AnyMCP forwards it to your AI app; if the app can't do that, it can call the Claude API with your own key, but only after you turn it on:

```sh
anymcp server sampling on                          # uses ANTHROPIC_API_KEY or your `ant auth login` profile
anymcp server sampling on --model claude-sonnet-5-5 --api-key sk-ant-…
anymcp server sampling off
```

Remote servers are tried over Streamable HTTP first and fall back to the older SSE transport automatically (force one with `--transport sse`).

**One copy of each server.** However many AI sessions you have open, only the main AnyMCP gateway (the one connected to Chrome) runs your servers; the others send their calls to it. A server's questions still go back to the session that made the call: a server works for one session at a time (calls from the same session run side by side, other sessions wait their turn), so a question always has exactly one owner.

## Staying in control

- **It pauses for you instead of giving up.** If a site says you're signed out (or sends the AI to a login page), AnyMCP opens the site in Chrome, asks you to sign in, waits, and retries. AnyMCP never asks for passwords or codes itself: you sign in on the real site. The AI can also ask you anything mid-task with `ask_user` and wait for the answer.
- **First use of a site asks you.** Choose "always" to stop being asked for that site.
- **Anything that changes data asks every time** (posting, buying, deleting), unless you choose "always" for that tool.
- If your AI app can't show the question, the extension opens a small approval window. If neither is available, run `anymcp allow <site>`.
- **The extension only works on sites you allow.** When your AI needs a new site, a small window asks you; you can also click **Allow on this site** in the side panel.
- Text from web pages is marked as untrusted, so the AI treats it as content and not as instructions.

## Keeping your accounts safe

Sites like Instagram, Facebook, X and LinkedIn limit or block accounts that act like bots. AnyMCP runs as you, in your own browser, so to the site it looks like you, as long as it behaves like a person. To keep it that way, AnyMCP paces everything it does on a site, whether through a tool or the browser tools:

| Pace | Used for | Between calls | Changes to data (posts, likes, follows, messages) |
|---|---|---|---|
| **strict** | Social networks, marketplaces, Google, Amazon… | 3–8 s, at most 8 a minute, 150 an hour | 30–75 s apart, at most 10 an hour and 40 a day |
| **normal** | Other signed-in sites | 1–2.5 s, at most 25 a minute | 8–20 s apart, at most 40 an hour and 200 a day |
| **relaxed** | Public APIs (weather, Wikipedia, npm…) | a fraction of a second | 2–5 s apart |

Gaps are random, so the timing isn't machine-regular. The daily caps on posts, likes, follows and messages apply even if you chose "always allow".

**When a site pushes back, AnyMCP stops.** It watches for HTTP 429 ("too many requests"), captchas, security checks (Instagram `/challenge`, Facebook `/checkpoint`, Google's "unusual traffic" page), action blocks (`feedback_required`) and "rate limit exceeded" or "please wait a few minutes" replies. That site is then paused for everything, browser tools included: for as long as the site's `Retry-After` header asks, otherwise 15 minutes, then 1 hour, 6 hours and 24 hours if it happens again within a day. The AI is told to stop and tell you. Four failed calls in a row also pause a site for 10 minutes, because repeating a broken request looks automated.

**What you can do:**
- Prefer reading over acting. Bulk following, liking, messaging or posting is what gets accounts restricted, at any speed.
- If a site shows you a check ("confirm it's you", a captcha), clear it in Chrome, then run `anymcp resume <site>`.
- `anymcp pace` shows each site's pace, how much AnyMCP did there today, and any pauses.
- `anymcp pace <site> strict|normal|relaxed|off|auto` changes a site's pace. Faster raises the risk.

**Read the site's terms.** Many sites don't allow automated use, even of your own account. AnyMCP says so the first time it uses one of these sites, and you use it at your own risk. Pacing lowers the chance of a block; it can't rule one out.

## CLI

```text
anymcp                     Run the MCP server (this is what your AI app launches)
anymcp token               Print the pairing token for the browser extension
anymcp list                List site profiles and whether you've allowed them
anymcp allow <profile-id>  Allow a site's tools without being asked
anymcp revoke <profile-id> Remove that approval
anymcp install <file.json> Add a profile file as one of your own profiles
anymcp remove <profile-id> Delete one of your own profiles
anymcp validate <file>     Check a profile file
anymcp stats [reset]       How many tokens AnyMCP has saved
anymcp pace                Show how AnyMCP paces each site, and any paused sites
anymcp pace <site> <pace>  Set a site's pace: strict, normal, relaxed, off or auto
anymcp resume <site>       End a pause early, once you've cleared the site's check
anymcp server …            Connect your other MCP servers (see above)
```

Settings and data live in `~/.anymcp` (set `ANYMCP_HOME` to change it).

## Community registry

Site tools are described by **profiles**: plain JSON files, never code. The registry in [`registry/`](registry/) has 11 profiles to start with (Hacker News, Wikipedia, GitHub, npm, PyPI, Stack Overflow, Open-Meteo, OpenStreetMap, arXiv, a dictionary and CoinGecko) and four curated lists.

To add a site, see [CONTRIBUTING.md](CONTRIBUTING.md). The format is in [docs/profile-format.md](docs/profile-format.md).

## Development

```sh
npm install
npm run build              # shared → registry index → gateway → extension
npm test                   # shared and gateway tests
npm run validate:registry  # check profiles, lists and categories
npm run package:extension  # zip the extension for the Chrome Web Store
```

| Path | What |
|---|---|
| `packages/gateway` | The `anymcp` MCP server and CLI |
| `packages/extension` | Chrome extension: runs tools in tabs, side panel, tool generation |
| `packages/shared` | Wire protocol, profile schema, templating, tool generation, privacy scan |
| `registry/` | Community profiles, categories and lists; `index.json` is generated |
| `docs/` | Profile format, publishing guide |

Design and milestones: [PLAN.md](PLAN.md). Privacy: [PRIVACY.md](PRIVACY.md). Releasing: [docs/publishing.md](docs/publishing.md).

## License

MIT
