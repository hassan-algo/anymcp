# Contributing

The most useful thing you can add is a **site profile**: a JSON file that turns a website into tools any AnyMCP user can call. Code contributions are welcome too.

## Add a site profile

### From the extension (easiest)

1. Open the site and the AnyMCP side panel, then click **Allow on this site**.
2. Make tools in one of these ways:
   - **Scan page**: turns the page's forms, OpenAPI spec or WebMCP tools into tools.
   - **Record**: click around the site while AnyMCP watches the API calls it makes, then click **Stop**.
3. Review the draft. Rename tools, write clear descriptions, untick anything you don't want, and check **Changes data** on anything that posts, buys or deletes.
4. **Save**, then try every tool from your AI.
5. **Publish**. AnyMCP checks the profile for personal data and shows what it found. Fix anything marked as blocking. It then opens GitHub with the file filled in, so you can open a pull request.

### By hand

1. Create `registry/sites/<domain>/profile.json`. The folder name must equal the profile's `id`. The format is in [docs/profile-format.md](docs/profile-format.md); copy an existing profile to start.
2. Check it: `npx -y anymcp-gateway validate registry/sites/<domain>/profile.json`.
3. Try it: `npx -y anymcp-gateway install registry/sites/<domain>/profile.json`, then ask your AI to use each tool. Remove it again with `npx -y anymcp-gateway remove <id>`.
4. Rebuild the index: `npm run build:registry`.
5. Open a pull request with the profile and the updated `registry/index.json`.

To add a curated list, create `registry/lists/<id>.json` (see the existing ones).

## Review rules

Pull requests to `registry/` are checked automatically, then reviewed by a maintainer. A profile is accepted when:

- **It's JSON only.** No scripts, no code, nothing that runs.
- **It has no secrets or personal data.** No tokens, cookies, emails, account or workspace IDs. Anything specific to you must be a parameter. For logged-in sites, use `{$cookie:…}` or `{$meta:…}` placeholders for CSRF tokens.
- **`allowedHosts` lists exactly the hosts the tools call**, and they belong to the site (or its official API).
- **Every tool works**, and you tried it.
- **Descriptions are clear and specific.** They're what the AI searches.
- **`mutates` is honest.** Anything that changes data must be `true`.
- **Responses are trimmed** with `pick` and `fields`, so the AI gets what it needs and not a wall of JSON.
- **The site allows it.** Don't add tools that break a site's terms or get around paywalls, rate limits or bot protection.

Site owners can mark a profile as official by serving it at `https://<their-site>/.well-known/anymcp.json`.

## Code

```sh
npm install
npm run build
npm test
```

- `packages/shared`: profile schema, templating, response shaping, tool generation, privacy scan. Tests in `packages/shared/test`.
- `packages/gateway`: the MCP server and CLI. Tests in `packages/gateway/test`.
- `packages/extension`: the Chrome extension.

Keep pull requests focused, add tests for new behavior, and run `npm test` before opening one.
