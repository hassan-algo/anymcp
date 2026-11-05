## What this changes

<!-- e.g. "Adds a profile for example.com with 3 tools" -->

## Site profile checklist

Skip this if your PR doesn't touch `registry/`.

- [ ] I called every tool at least once and it returned what its description says.
- [ ] No personal data: no emails, account IDs, tokens, cookies or session values. The extension's publish check passed, or I checked by hand.
- [ ] Every host the tools call is in `allowedHosts`, and nothing else is.
- [ ] Descriptions say what each tool does and returns, so an AI can find it by searching.
- [ ] `mutates` is `true` for every tool that posts, buys, sends, edits or deletes anything.
- [ ] I ran `npm run build:registry` and committed `registry/index.json`.
