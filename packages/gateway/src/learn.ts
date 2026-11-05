// Turns the requests a site made while the AI used the browser tools into new tools, so next
// time the AI can make one call instead of clicking through the site.

import fs from "node:fs";
import path from "node:path";
import { inferTools, operationKey, originMatches, patchTool, toolSignature, uniqueName, validateProfile, type CapturedRequest, type Profile, type Tool } from "@anymcp/shared";
import type { Catalog } from "./catalog.js";
import { writeFileAtomic, type Paths } from "./config.js";
import { recentlyFailed } from "./health.js";

export interface LearnResult {
  added: string[];
  known: number;
  profileId?: string;
  /** Existing tools the AI's clicks did the same thing as. */
  matched?: string[];
  /** Existing tools that were updated from the fresh requests. */
  improved?: string[];
}

export interface LearnedNotice {
  at: string;
  profileId: string;
  host: string;
  tools: string[];
  /** Existing tools the AI's clicks matched, with ids seen in those requests (for the next call). */
  matched?: { tool: string; examples: Record<string, unknown> }[];
  improved?: { tool: string; changes: string[] }[];
}

const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_NEW_TOOLS = 15;

function noticesFile(paths: Paths): string {
  return path.join(paths.home, "learned.json");
}

export function readNotices(paths: Paths): LearnedNotice[] {
  try {
    const v = JSON.parse(fs.readFileSync(noticesFile(paths), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function addNotice(paths: Paths, n: LearnedNotice): void {
  // Old notices may hold ids from past sessions: keep only the last day.
  const cutoff = new Date(Date.now() - NOTICE_TTL_MS).toISOString();
  const all = [...readNotices(paths).filter((x) => x.at >= cutoff), n].slice(-50);
  writeFileAtomic(noticesFile(paths), JSON.stringify(all, null, 2) + "\n");
}

/** The fallback every new site gets: open any page by its path and read it. */
function openPathTool(host: string, siteId: string): Tool {
  return {
    name: "open_path",
    title: `Open a ${siteId} page`,
    description:
      `Opens any page on ${siteId} by its path (e.g. "" for the home page, or "search?q=shoes") in a background tab, ` +
      "signed in as the user, and returns the page text. Use it when no other tool for this site fits.",
    input: { type: "object", properties: { path: { type: "string", default: "", description: "Path after the domain, with any ?query" } } },
    mutates: false,
    action: { kind: "page", url: `https://${host}/{+path}`, maxChars: 20_000 },
  };
}

function bumpPatch(v: string): string {
  const [a, b, c] = v.split(".").map(Number);
  return `${a ?? 0}.${b ?? 0}.${(c ?? 0) + 1}`;
}

export function learnFromActivity(catalog: Catalog, paths: Paths, url: string, requests: CapturedRequest[], now = new Date()): LearnResult {
  let origin: URL;
  try {
    origin = new URL(url);
  } catch {
    throw new Error(`Bad page address "${url}".`);
  }
  if (origin.protocol !== "https:") return { added: [], known: 0 };
  const host = origin.host;
  const siteId = host.replace(/^www\./, "");

  // Keep API calls, and page tools that take inputs (search pages, profiles by name…).
  // Fixed pages are covered by the site's open_path tool.
  const result = inferTools(requests);
  const inferred = result.tools.filter((t) => t.action.kind === "http" || (t.action.kind === "page" && Object.keys(t.input.properties).length > 0));
  let forSite = catalog.all().filter((e) => originMatches(e.profile.origins, origin.toString()));
  const bySig = new Map<string, { profileId: string; tool: Tool }>();
  const byOp = new Map<string, { profileId: string; tool: Tool }>();
  for (const e of forSite) {
    for (const t of e.profile.tools) {
      bySig.set(toolSignature(t), { profileId: e.profile.id, tool: t });
      byOp.set(operationKey(t), { profileId: e.profile.id, tool: t });
    }
  }
  const failing = recentlyFailed(paths, now.getTime());

  const fresh: Tool[] = [];
  const matched: { tool: string; examples: Record<string, unknown> }[] = [];
  const improved: { tool: string; changes: string[] }[] = [];
  const updates = new Map<string, Map<string, Tool>>(); // profile id -> tool name -> new tool
  const seen = new Set<string>();
  let knownCount = 0;
  for (const t of inferred) {
    const sig = toolSignature(t);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const d = result.details[t.name];
    const existing = bySig.get(sig) ?? byOp.get(operationKey(t));
    if (existing) {
      knownCount++;
      const id = `${existing.profileId}/${existing.tool.name}`;
      // Tell the AI which tool its click could have been, with the ids it used.
      if (d?.trigger === "action") {
        const props = existing.tool.input.properties;
        matched.push({ tool: id, examples: Object.fromEntries(Object.entries(d.examples).filter(([k]) => k in props)) });
      }
      // Improve it: refresh ids the site changed, add new inputs, or rebuild a tool that stopped working.
      const rebuild = failing.has(id) && d?.trigger === "action";
      const { tool: patched, changes } = patchTool(existing.tool, t, rebuild);
      if (changes.length) {
        if (!updates.has(existing.profileId)) updates.set(existing.profileId, new Map());
        updates.get(existing.profileId)!.set(existing.tool.name, patched);
        improved.push({ tool: id, changes: rebuild ? [...changes, "it had stopped working"] : changes });
      }
      continue;
    }
    // Opening a page sets off lots of startup calls. Only keep the ones that read data.
    if (d?.trigger === "navigate" && t.mutates) continue;
    fresh.push(t);
  }

  // Save improved tools. A registry profile gets a local copy (it then overrides the registry one).
  for (const [profileId, tools] of updates) {
    const entry = catalog.get(profileId);
    if (!entry) continue;
    const p = structuredClone(entry.profile);
    p.tools = p.tools.map((t) => tools.get(t.name) ?? t);
    p.version = bumpPatch(p.version);
    if (validateProfile(p).ok) catalog.saveLocal(p);
    else {
      const failed = new Set([...tools.keys()].map((name) => `${profileId}/${name}`));
      for (let i = improved.length - 1; i >= 0; i--) if (failed.has(improved[i]!.tool)) improved.splice(i, 1);
    }
  }
  if (updates.size) forSite = catalog.all().filter((e) => originMatches(e.profile.origins, origin.toString()));

  // A site the AI used for the first time gets an entry even if nothing else was learned.
  const isNewSite = forSite.length === 0;
  const extras = () => ({ ...(matched.length ? { matched } : {}), ...(improved.length ? { improved } : {}) });
  const noteOnly = () => {
    if (matched.length || improved.length) {
      addNotice(paths, { at: now.toISOString(), profileId: (improved[0] ?? matched[0])!.tool.split("/")[0]!, host: siteId, tools: [], ...extras() });
    }
    return { added: [], known: knownCount, matched: matched.map((m) => m.tool), improved: improved.map((m) => m.tool) };
  };
  if (!fresh.length && !isNewSite) return noteOnly();

  if (!fresh.length && !isNewSite) return noteOnly();
  const merged = mergeIntoSite(catalog, origin.toString(), fresh, `Learned from your AI's work on ${now.toISOString().slice(0, 10)}.`);
  if (!merged.added.length) return noteOnly();
  addNotice(paths, { at: now.toISOString(), profileId: merged.profileId!, host: siteId, tools: merged.added, ...extras() });
  return { added: merged.added, known: knownCount, profileId: merged.profileId, matched: matched.map((m) => m.tool), improved: improved.map((m) => m.tool) };
}

function hostOfAction(tool: Tool): string | undefined {
  const a = tool.action;
  try {
    if (a.kind === "mcp") return undefined;
    return new URL((a.kind === "http" || a.kind === "page" ? a.url : a.page).replace(/\{[^}]+\}/g, "x")).host;
  } catch {
    return undefined;
  }
}

/**
 * Adds tools to the user's own profile for a site (creating it, with an open_path tool, if the site
 * has no entry yet). Skips tools the site already has. Returns the ids of what was added.
 */
export function mergeIntoSite(catalog: Catalog, url: string, tools: Tool[], note: string): { added: string[]; profileId?: string } {
  const origin = new URL(url);
  const host = origin.host;
  const siteId = host.replace(/^www\./, "");
  const forSite = catalog.all().filter((e) => originMatches(e.profile.origins, origin.toString()));
  const existing = new Set(forSite.flatMap((e) => e.profile.tools.map(toolSignature)));
  const local = forSite.find((e) => e.source === "local")?.profile;
  const isNew = forSite.length === 0;
  const base: Profile = local
    ? structuredClone(local)
    : {
        schemaVersion: 1,
        id: catalog.get(siteId) ? `${siteId}-learned` : siteId,
        name: siteId,
        description: `Pages and tools AnyMCP picked up while your AI used ${siteId}.`,
        version: "0.1.0",
        authors: ["you"],
        categories: ["learned"],
        origins: [origin.origin],
        auth: "browser-session",
        allowedHosts: [host],
        tools: [openPathTool(host, siteId)],
      };

  const names = new Set(base.tools.map((t) => t.name));
  const added: Tool[] = [];
  for (const t of tools.slice(0, MAX_NEW_TOOLS)) {
    const sig = toolSignature(t);
    if (existing.has(sig)) continue;
    existing.add(sig);
    const tool: Tool = {
      ...t,
      name: uniqueName(t.name, names),
      description: `${t.description.replace(/ (Recorded from (the site|the page|your visit))[^.]*; edit this description\.$/, "")} ${note}`.trim(),
    };
    const toolHost = hostOfAction(tool) ?? host;
    const candidate: Profile = { ...base, allowedHosts: [...new Set([...base.allowedHosts, toolHost])], tools: [...base.tools, tool] };
    // One at a time, so one odd tool can't block the rest.
    if (validateProfile(candidate).ok) {
      base.tools = candidate.tools;
      base.allowedHosts = candidate.allowedHosts;
      added.push(tool);
    } else {
      names.delete(tool.name);
    }
  }
  if (!added.length && !(isNew && !local)) return { added: [] };
  if (local) base.version = bumpPatch(base.version);
  const saved = catalog.saveLocal(base);
  return { added: (isNew && !local ? [base.tools[0]!, ...added] : added).map((t) => `${saved.id}/${t.name}`), profileId: saved.id };
}
