# Publishing AnyMCP

There are three things to release: the gateway on npm, the extension on the Chrome Web Store, and the registry on GitHub. Set up the GitHub repo first, because the other two point at it.

## 1. GitHub repo and registry

1. Create a public GitHub repo, for example `your-name/anymcp`, and push this project to it.
2. Turn on GitHub Actions. `ci.yml` builds and tests every push. `registry.yml` checks pull requests that change `registry/`.
3. Protect `main`: require the **CI** and **Registry** checks, and a review, before merging.
4. Point AnyMCP at the registry. The URL clients download is the raw `index.json`:

   ```text
   https://raw.githubusercontent.com/your-name/anymcp/main/registry/index.json
   ```

   Users can set it themselves in the extension's side panel (Settings), or in `~/.anymcp/config.json`:

   ```json
   {
     "registryUrl": "https://raw.githubusercontent.com/your-name/anymcp/main/registry/index.json",
     "registryRepo": "your-name/anymcp"
   }
   ```

   `registryRepo` is where **Publish** opens pull requests. To make these the defaults for everyone, set them in the gateway's config defaults before you publish to npm.

5. The gateway also ships a copy of `registry/index.json` from build time, so it works offline and before anyone sets a URL.

Every merged profile reaches users the next time their gateway syncs (every few hours, or right away with **Sync registry** in the side panel). No new release needed.

## 2. Gateway on npm

The package is `packages/gateway` (name `anymcp-gateway`; the command it installs is `anymcp`). The build bundles everything into `dist/`, so it installs quickly with `npx`.

```sh
npm run build
npm test
cd packages/gateway
npm version patch        # or minor / major
npm publish --access public
```

- The name `anymcp` on npm belongs to an unrelated project, which is why this one is `anymcp-gateway`.
- Check what's included first with `npm pack --dry-run`.
- Update the version in the gateway's `version.ts` together with `package.json`, if they're separate.

## 3. Extension on the Chrome Web Store

```sh
npm run build
npm run package:extension    # writes a .zip in packages/extension
```

1. Register as a Chrome Web Store developer (one-time fee) at the [developer dashboard](https://chrome.google.com/webstore/devconsole).
2. **New item** → upload the zip.
3. Fill in the listing: name, description, screenshots (1280×800), the 128×128 icon, category **Developer Tools**.
4. **Privacy practices**: link to `PRIVACY.md` (for example its GitHub URL). Explain each permission:
   - `tabs`: list tabs and find the tab for a site.
   - `scripting`: read pages and run tools in tabs, only on sites the user allows.
   - `storage`: settings and pairing token.
   - `alarms`: reconnect to the local gateway.
   - `sidePanel`: the AnyMCP side panel.
   - optional host access: requested per site when the user clicks **Allow on this site**.
   - Single purpose: "Lets the user's AI app use websites as tools, through a local MCP server."
   - Data use: no data is collected or sold.
5. Submit for review. Review usually takes a few days, longer for broad host access.

After it's approved, update the README's install step to link to the store page. Bump `version` in `packages/extension/static/manifest.json` for each new upload.

## Release checklist

- [ ] `npm run build && npm test && npm run validate:registry` pass.
- [ ] Versions bumped (gateway `package.json`, extension `manifest.json`).
- [ ] Tested end to end: AI app → gateway → extension → a public tool and a logged-in tool.
- [ ] README install steps still right.

## Extension ID and pairing

The gateway pairs with the extension automatically by its ID (`TRUSTED_EXTENSION_IDS` in `packages/shared/src/protocol.ts`). The unpacked build has a fixed ID, `lakpncfioijpankpckjhpmpielbempik`, because `packages/extension/static/manifest.json` contains a `key`. The Chrome Web Store build's ID is `bgcgfbimbddjmojlkbhknlihafjmmacc`, already in `TRUSTED_EXTENSION_IDS`. (You can also replace the manifest `key` with the store's public key so local builds get the store ID.) Users can trust extra IDs without a release by setting `ANYMCP_EXTENSION_IDS=id1,id2` for the gateway.
