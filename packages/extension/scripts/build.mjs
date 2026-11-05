// Bundles the extension into dist/ (load that folder unpacked in Chrome).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  target: "chrome116",
  platform: "browser",
  sourcemap: "linked",
  logLevel: "warning",
  legalComments: "none",
};

await Promise.all([
  // The service worker is an ES module.
  build({ ...common, entryPoints: [path.join(root, "src/background.ts")], outfile: path.join(dist, "background.js"), format: "esm" }),
  ...["sidepanel", "approve", "setup", "allow", "ask"].map((name) =>
    build({ ...common, entryPoints: [path.join(root, `src/${name}.ts`)], outfile: path.join(dist, `${name}.js`), format: "iife" }),
  ),
  // Page scripts: plain IIFEs, injected into web pages.
  ...["recorder", "relay", "webmcp", "live"].map((name) =>
    build({ ...common, sourcemap: false, entryPoints: [path.join(root, `src/page/${name}.ts`)], outfile: path.join(dist, `page/${name}.js`), format: "iife" }),
  ),
]);

fs.cpSync(path.join(root, "static"), dist, { recursive: true });
console.log(`Built ${path.relative(process.cwd(), dist) || dist}`);
