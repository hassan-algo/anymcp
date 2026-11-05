// Zips dist/ into anymcp-extension.zip for the Chrome Web Store.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const out = path.join(root, "anymcp-extension.zip");
fs.rmSync(out, { force: true });
// Source maps aren't needed in the store build.
execFileSync("zip", ["-r", "-q", "-X", out, ".", "-x", "*.map", "-x", ".DS_Store"], { cwd: dist, stdio: "inherit" });
console.log(`Wrote ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
