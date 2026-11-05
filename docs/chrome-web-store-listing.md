# Chrome Web Store listing

Copy these into the [developer dashboard](https://chrome.google.com/webstore/devconsole) when you submit AnyMCP. Upload `packages/extension/anymcp-extension.zip` (made by `npm run package:extension`; the store copy leaves out the manifest `key`).

## Store listing

**Name:** AnyMCP

**Summary** (132 characters max):

> Turn any website into tools your AI can use: one MCP install for Claude, Cursor and more, signed in as you, with far fewer tokens.

**Category:** Developer Tools

**Language:** English

**Description:**

> AnyMCP lets the AI app you already use (Claude Code, Claude Desktop, Cursor or any MCP app) use websites for you, through one local MCP server.
>
> Ask your AI things like:
> • "Find the most-starred Rust web frameworks on GitHub"
> • "What has @natgeo posted on Instagram this week?"
> • "Send a message to @alex on Instagram saying I'm running late"
> • "Read this page and give me the key points"
>
> How it works
> • Your AI searches a shared library of site tools and loads only the one it needs.
> • When there's no tool yet, your AI does the task in the browser once, and AnyMCP turns the requests the site made into a tool. Next time it's a single call.
> • Tools for signed-in sites run inside your own Chrome tab, so your existing sign-ins just work. AnyMCP never reads, stores or sends your passwords or cookies.
>
> Fewer tokens
> In our measurements, AI apps used 93–95% fewer tokens: the tool list stays small however many sites you add, and responses are trimmed to what matters.
>
> You stay in control
> • AnyMCP only works on sites you allow.
> • The first use of a site, and anything that posts, buys or deletes, asks you first.
> • It paces what it does on each site and stops if a site pushes back.
> • AnyMCP has no servers and collects no data. Everything runs on your computer.
>
> Requires the free AnyMCP gateway: run `npx -y anymcp-gateway` from your AI app (setup in the GitHub README).

**Icon:** `packages/extension/static/icons/icon128.png`

**Screenshots:** `packages/extension/store/screenshot-1.png`, `-2.png`, `-3.png` (1280×800).

**Small promo tile:** `packages/extension/store/promo-tile.png` (440×280).

The images are drawn from `packages/extension/store/screenshots.html`; run `packages/extension/store/render.sh` to redraw them.

**Homepage / support URL:** https://github.com/hassan-algo/anymcp

## Privacy practices

**Single purpose:**

> Lets the user's AI app use websites as tools, through an MCP server running on the user's own computer.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `tabs` | Lists the user's tabs for their AI app, and finds or opens the tab for a site so a tool can run there. |
| `scripting` | Reads page text and runs the user's tools (fill a form, click, send a request) in tabs, only on sites the user has allowed. |
| `storage` | Saves the user's settings, approvals and pairing token in the browser. |
| `alarms` | Reconnects to the AnyMCP gateway running on the user's computer when the service worker wakes up. |
| `sidePanel` | Shows the AnyMCP side panel: connection status, the current site's tools, token savings and settings. |
| Optional host access (`<all_urls>`) | Not granted at install. Requested one site at a time when the user clicks "Allow on this site" or approves a site their AI wants to use, so tools can run on that site. |

**Remote code:** No. All code is in the package; the extension only exchanges data (JSON) with the gateway on `127.0.0.1`.

**Data usage:** tick nothing as collected. The extension doesn't collect or transmit user data to the developer. It sends page content only to the user's own AI app through the local gateway, at the user's request. Then confirm:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/hassan-algo/anymcp/blob/main/PRIVACY.md

## After approval

1. Add the store's extension ID to `TRUSTED_EXTENSION_IDS` in `packages/shared/src/protocol.ts` and publish a new gateway version, so the store build pairs automatically.
2. Link the store page from the README's install step.
