// Zips dist/ into anymcp-extension.zip for the Chrome Web Store.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const out = path.join(root, "anymcp-extension.zip");
fs.rmSync(out, { force: true });
// The Chrome Web Store refuses a manifest with "key" (it gives the extension its own key and ID),
// so the store copy leaves it out. Local builds keep it for their fixed ID.
const stage = fs.mkdtempSync(path.join(root, ".store-"));
try {
  fs.cpSync(dist, stage, { recursive: true });
  const manifestFile = path.join(stage, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  delete manifest.key;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  // Source maps aren't needed in the store build.
  execFileSync("zip", ["-r", "-q", "-X", out, ".", "-x", "*.map", "-x", ".DS_Store"], { cwd: stage, stdio: "inherit" });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
console.log(`Wrote ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
