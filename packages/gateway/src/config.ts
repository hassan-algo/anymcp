// Files under ~/.anymcp (or $ANYMCP_HOME):
//   config.json                 pairing token, port, registry settings
//   state.json                  approvals and pins
//   profiles/<id>.json          your own profiles
//   cache/registry-index.json   last downloaded community registry

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT } from "@anymcp/shared";

export interface Paths {
  home: string;
  configFile: string;
  stateFile: string;
  profilesDir: string;
  cacheDir: string;
  registryCache: string;
}

export function getPaths(): Paths {
  const home = process.env.ANYMCP_HOME ?? path.join(os.homedir(), ".anymcp");
  return {
    home,
    configFile: path.join(home, "config.json"),
    stateFile: path.join(home, "state.json"),
    profilesDir: path.join(home, "profiles"),
    cacheDir: path.join(home, "cache"),
    registryCache: path.join(home, "cache", "registry-index.json"),
  };
}

/** Writes via a temp file and rename, so readers never see half a file. */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// ---- Settings ---------------------------------------------------------------

export interface Settings {
  token: string;
  port: number;
  registryUrl?: string;
  registryRepo?: string;
}

interface StoredSettings {
  token?: string;
  port?: number;
  registryUrl?: string;
  registryRepo?: string;
}

function readStoredSettings(paths: Paths): StoredSettings {
  const raw = readJson(paths.configFile);
  return raw && typeof raw === "object" ? (raw as StoredSettings) : {};
}

/** Reads config.json, creating it with a fresh pairing token on first run. */
export function loadSettings(paths = getPaths()): Settings {
  const stored = readStoredSettings(paths);
  let token = typeof stored.token === "string" && stored.token ? stored.token : undefined;
  if (!token) {
    token = randomBytes(24).toString("hex");
    writeFileAtomic(paths.configFile, JSON.stringify({ ...stored, token }, null, 2) + "\n");
  }
  const port = Number(process.env.ANYMCP_PORT) || (typeof stored.port === "number" ? stored.port : DEFAULT_PORT);
  return {
    token,
    port,
    registryUrl: process.env.ANYMCP_REGISTRY_URL ?? stored.registryUrl,
    registryRepo: stored.registryRepo,
  };
}

export function saveSettings(patch: { registryUrl?: string; registryRepo?: string }, paths = getPaths()): void {
  const stored = readStoredSettings(paths);
  const next: StoredSettings = { ...stored };
  for (const key of ["registryUrl", "registryRepo"] as const) {
    if (patch[key] === undefined) continue;
    const v = patch[key]!.trim();
    if (v) next[key] = v;
    else delete next[key];
  }
  writeFileAtomic(paths.configFile, JSON.stringify(next, null, 2) + "\n");
}

// ---- State ------------------------------------------------------------------

export interface SiteApproval {
  site: boolean;
  alwaysTools: string[];
}

export interface State {
  approvals: Record<string, SiteApproval>;
  /** Profile ids, "list:<id>", or tool ids "<profileId>/<tool>". */
  pinned: string[];
}

export function loadState(paths = getPaths()): State {
  const raw = readJson(paths.stateFile) as Partial<State> | undefined;
  const approvals: Record<string, SiteApproval> = {};
  if (raw?.approvals && typeof raw.approvals === "object") {
    for (const [id, a] of Object.entries(raw.approvals)) {
      approvals[id] = {
        site: Boolean(a?.site),
        alwaysTools: Array.isArray(a?.alwaysTools) ? a.alwaysTools.filter((t) => typeof t === "string") : [],
      };
    }
  }
  const pinned = Array.isArray(raw?.pinned) ? raw.pinned.filter((p): p is string => typeof p === "string") : [];
  return { approvals, pinned };
}

export function saveState(state: State, paths = getPaths()): void {
  writeFileAtomic(paths.stateFile, JSON.stringify(state, null, 2) + "\n");
}

/** Loads state, applies `change`, saves it. Re-reads first so other processes' edits aren't lost. */
export function updateState(change: (s: State) => void, paths = getPaths()): State {
  const s = loadState(paths);
  change(s);
  saveState(s, paths);
  return s;
}
