# Privacy policy

_Last updated: 5 November 2026_

AnyMCP is a browser extension and a small program that runs on your computer (the "gateway"). Together they let an AI app you choose use websites on your behalf.

## The short version

- AnyMCP has no servers and no accounts, and collects nothing about you.
- Everything runs on your computer.
- Data only leaves your computer when a tool you (or your AI) call sends a request to that tool's website, or when AnyMCP downloads the community registry.

## What the extension accesses

- **Pages on sites you allow.** When your AI calls a browser tool or a site tool, the extension reads or acts on a page in your browser: reading its text, clicking, filling in forms, taking a screenshot, or sending a request from that page. It only works on sites you've allowed in the side panel.
- **Your sign-ins.** Tools for logged-in sites run inside your own browser tab, so the site sees you as signed in. AnyMCP never reads, stores or sends your cookies or passwords. The `{$cookie:…}` and `{$meta:…}` placeholders are filled inside the page and sent only to that same site.
- **Recordings.** When you click **Record**, the extension notes the requests the page makes and the pages you visit (address, method, request body, the names of request headers and the start of the response) so it can suggest tools. Cookie values and secret header values are never recorded; the extension only notes that a header is a session code, or which cookie or meta tag it matched. Recordings stay in your browser's session storage and are deleted when you stop, clear, or close the browser. When tools are made from a recording, the values you typed and the session codes are replaced by placeholders, so they don't end up in the saved profile.
- **Session values for your tools.** On sites you've allowed, a small script keeps the latest values the page itself sent with its requests (for example a CSRF token), in that page's memory only. They're used to fill `{$live:…}` placeholders when one of your tools sends a request to that same site. They're never stored, never sent to the gateway or your AI app, and gone when you close or reload the page.

## Where data goes

- **To your AI app**, through the gateway on your computer: the results of the tools it calls. What your AI app does with them is covered by that app's privacy policy.
- **To the websites the tools call.** Each tool can only reach the hosts its profile lists in `allowedHosts`.
- **To the registry.** The gateway may download the community registry (a single JSON file) from the address in your settings. This is a plain download and sends nothing about you.
- **To GitHub, only if you publish.** Publishing a profile opens GitHub in your browser with the profile filled in. You choose whether to submit it. Before that, AnyMCP scans the profile for personal data and shows you what it found.

The extension and the gateway talk over a local connection on your computer (`127.0.0.1`), protected by a pairing token. Web pages can't connect to it.

## What's stored on your computer

- In the extension: the pairing token, your settings, and the sites you've allowed.
- In `~/.anymcp`: the pairing token, your settings, your approvals and pins, profiles you've made or installed, and a cached copy of the registry.

Uninstalling the extension removes its data. Delete `~/.anymcp` to remove the rest.

## Contact

Questions or concerns: open an issue in the AnyMCP GitHub repository.

## Learning from your AI's browser work

When learning is on (Settings → "Learn from your AI's browser work", on by default) and your AI uses the browser tools on a site you allowed, the extension records the requests that site makes in the few seconds after each action. They're sent only to the AnyMCP gateway on your own computer, which turns them into tools in your local profile for that site, and then discarded. As with recording, only the request shapes are kept: values you typed or that identify you become parameters, and session codes become placeholders the browser fills in later. Nothing is sent anywhere else, and you can remove learned tools from the side panel.
