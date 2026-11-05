// Bundles the gateway into one file (dist/index.js) so `npx -y anymcp-gateway` needs no private packages.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });

await build({
  define: { __ANYMCP_BUILD__: String(Date.now()) },
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "none",
  // Optional native speedups for ws; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __anymcpCreateRequire } from "node:module";',
      "const require = __anymcpCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});
fs.chmodSync(path.join(dist, "index.js"), 0o755);

const index = path.join(root, "../../registry/index.json");
if (fs.existsSync(index)) {
  fs.copyFileSync(index, path.join(dist, "registry-index.json"));
} else {
  console.warn("registry/index.json not found; building without a bundled registry (run scripts/build-registry.mjs).");
}
