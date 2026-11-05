// Remembers which site tools failed recently, so learning can repair them. ~/.anymcp/health.json

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic, type Paths } from "./config.js";

const RECENT_MS = 24 * 60 * 60 * 1000;

function file(paths: Paths): string {
  return path.join(paths.home, "health.json");
}

function load(paths: Paths): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(file(paths), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** ok=false marks the tool as failing now; ok=true clears it. */
export function recordToolHealth(paths: Paths, toolId: string, ok: boolean): void {
  try {
    const h = load(paths);
    if (ok ? !(toolId in h) : false) return;
    if (ok) delete h[toolId];
    else h[toolId] = new Date().toISOString();
    writeFileAtomic(file(paths), JSON.stringify(h, null, 2) + "\n");
  } catch {
    // never break a tool call
  }
}

/** Tool ids that failed in the last day. */
export function recentlyFailed(paths: Paths, now = Date.now()): Set<string> {
  const cutoff = new Date(now - RECENT_MS).toISOString();
  return new Set(Object.entries(load(paths)).filter(([, at]) => at >= cutoff).map(([id]) => id));
}
