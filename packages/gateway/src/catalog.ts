// Everything the gateway knows about: bundled registry, downloaded registry, and your own profiles.
// Your own profiles win over registry ones with the same id.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  effectiveAuth,
  originMatches,
  RegistryIndexSchema,
  toolId,
  validateProfile,
  type Category,
  type Overview,
  type Profile,
  type ProfileList,
  type ProfileSummary,
  type Tool,
} from "@anymcp/shared";
import { writeFileAtomic, type Paths, type State } from "./config.js";

export type Source = ProfileSummary["source"];

export interface CatalogEntry {
  profile: Profile;
  source: Source;
}

export interface SearchHit {
  id: string;
  profileId: string;
  profileName: string;
  tool: Tool;
  auth: Profile["auth"];
  score: number;
}

const REMOTE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const STOP_WORDS = new Set(["a", "an", "the", "to", "of", "for", "on", "in", "and", "or", "my", "me", "i", "is", "with", "from", "at", "by"]);

export function defaultBundledIndexPath(): string {
  if (process.env.ANYMCP_BUNDLED_INDEX) return process.env.ANYMCP_BUNDLED_INDEX;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "registry-index.json");
}

/** Words people use vs words sites use in their API names. */
const SYNONYMS: Record<string, string[]> = {
  message: ["direct", "dm", "thread", "chat", "inbox", "igd", "messaging", "conversation"],
  messages: ["direct", "dm", "thread", "chat", "inbox", "igd", "messaging", "conversation"],
  dm: ["direct", "message", "thread", "igd"],
  chat: ["direct", "thread", "message", "conversation"],
  inbox: ["direct", "thread", "igd"],
  unread: ["badge", "unseen", "count"],
  post: ["media", "feed", "publish", "create"],
  posts: ["media", "feed", "timeline"],
  feed: ["timeline", "home"],
  profile: ["user", "account"],
  followers: ["follow", "follower"],
  following: ["follow", "followee"],
  story: ["stories", "reel", "tray"],
  stories: ["story", "reel", "tray"],
  notifications: ["activity", "news", "badge"],
  like: ["react", "reaction", "favorite"],
  comment: ["comments", "reply"],
  search: ["find", "query", "lookup", "typeahead"],
};

function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

interface LoadedIndex {
  categories: Category[];
  lists: ProfileList[];
  profiles: Profile[];
  generatedAt?: string;
}

export class Catalog {
  private entries = new Map<string, CatalogEntry>();
  /** Tools of other MCP servers connected through AnyMCP (built at run time, not from files). */
  private external: Profile[] = [];

  setExternal(profiles: Profile[]): void {
    this.external = profiles;
    this.reload();
  }
  private categoryList: Category[] = [];
  private listList: ProfileList[] = [];
  registryUpdatedAt?: string;
  private watchers: (() => void)[] = [];

  constructor(
    private readonly paths: Paths,
    private readonly log: (msg: string) => void,
    private readonly bundledPath = defaultBundledIndexPath(),
  ) {}

  // ---- Loading ----

  private readIndex(file: string, label: string): LoadedIndex | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log(`Could not read ${label} registry (${file}): ${(err as Error).message}`);
      return undefined;
    }
    const parsed = RegistryIndexSchema.safeParse(raw);
    if (!parsed.success) {
      this.log(`Ignoring ${label} registry: it doesn't match the index format.`);
      return undefined;
    }
    const profiles: Profile[] = [];
    for (const p of parsed.data.profiles) {
      const r = validateProfile(p);
      if (r.ok) profiles.push(r.profile);
      else this.log(`Skipping an invalid ${label} profile (${(p as { id?: string })?.id ?? "?"}): ${r.errors[0]}`);
    }
    return { categories: parsed.data.categories, lists: parsed.data.lists, profiles, generatedAt: parsed.data.generatedAt };
  }

  private readLocalProfiles(): Profile[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.paths.profilesDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: Profile[] = [];
    for (const f of files) {
      const file = path.join(this.paths.profilesDir, f);
      try {
        const r = validateProfile(JSON.parse(fs.readFileSync(file, "utf8")));
        if (r.ok) out.push(r.profile);
        else this.log(`Skipping invalid local profile ${file}: ${r.errors[0]}`);
      } catch (err) {
        this.log(`Skipping unreadable local profile ${file}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  reload(): void {
    const bundled = this.readIndex(this.bundledPath, "bundled");
    const remote = this.readIndex(this.paths.registryCache, "downloaded");
    const local = this.readLocalProfiles();

    const entries = new Map<string, CatalogEntry>();
    for (const p of bundled?.profiles ?? []) entries.set(p.id, { profile: p, source: "bundled" });
    for (const p of remote?.profiles ?? []) entries.set(p.id, { profile: p, source: "registry" });
    for (const p of local) entries.set(p.id, { profile: p, source: "local" });
    for (const p of this.external) entries.set(p.id, { profile: p, source: "mcp" });
    this.entries = entries;

    const cats = new Map<string, Category>();
    for (const c of [...(bundled?.categories ?? []), ...(remote?.categories ?? [])]) cats.set(c.id, c);
    if (this.external.length) cats.set("mcp", { id: "mcp", name: "MCP servers", description: "Other MCP servers connected through AnyMCP" });
    this.categoryList = [...cats.values()];

    const lists = new Map<string, ProfileList>();
    for (const l of [...(bundled?.lists ?? []), ...(remote?.lists ?? [])]) lists.set(l.id, l);
    this.listList = [...lists.values()];

    this.registryUpdatedAt = remote?.generatedAt ?? bundled?.generatedAt;
  }

  /** Calls `onChange` after reloading when local profiles or the downloaded registry change. */
  watch(onChange: () => void): void {
    let timer: NodeJS.Timeout | undefined;
    const trigger = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.reload();
        onChange();
      }, 200);
    };
    fs.mkdirSync(this.paths.profilesDir, { recursive: true, mode: 0o700 });
    try {
      const w = fs.watch(this.paths.profilesDir, trigger);
      w.on("error", () => undefined);
      this.watchers.push(() => w.close());
    } catch {
      // Fall back to polling below.
    }
    // fs.watch on directories is unreliable on some systems; a slow poll covers the gaps.
    const signature = () => {
      try {
        return fs
          .readdirSync(this.paths.profilesDir)
          .map((f) => `${f}:${fs.statSync(path.join(this.paths.profilesDir, f)).mtimeMs}`)
          .join("|");
      } catch {
        return "";
      }
    };
    let last = signature();
    const poll = setInterval(() => {
      const now = signature();
      if (now !== last) {
        last = now;
        trigger();
      }
    }, 2_000);
    poll.unref();
    this.watchers.push(() => clearInterval(poll));

    const onCache = () => trigger();
    fs.watchFile(this.paths.registryCache, { interval: 2_000 }, onCache);
    this.watchers.push(() => fs.unwatchFile(this.paths.registryCache, onCache));
  }

  close(): void {
    for (const w of this.watchers) w();
    this.watchers = [];
  }

  // ---- Remote registry ----

  /** Downloads the registry index if it's older than 6h (or always with force). Never throws. */
  async syncRemote(url: string | undefined, force = false): Promise<{ ok: boolean; profiles: number; error?: string }> {
    if (!url) return { ok: false, profiles: 0, error: "No registry URL is set." };
    if (!force) {
      try {
        const age = Date.now() - fs.statSync(this.paths.registryCache).mtimeMs;
        if (age < REMOTE_MAX_AGE_MS) return { ok: true, profiles: this.entries.size };
      } catch {
        // No cache yet.
      }
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const parsed = RegistryIndexSchema.safeParse(data);
      if (!parsed.success) throw new Error("the file doesn't match the registry index format");
      writeFileAtomic(this.paths.registryCache, JSON.stringify(parsed.data));
      this.reload();
      return { ok: true, profiles: parsed.data.profiles.length };
    } catch (err) {
      const error = `Could not download the registry from ${url}: ${(err as Error).message}`;
      this.log(error);
      return { ok: false, profiles: 0, error };
    }
  }

  // ---- Local profiles ----

  saveLocal(data: unknown): Profile {
    const r = validateProfile(data);
    if (!r.ok) throw new Error(`Invalid profile:\n${r.errors.join("\n")}`);
    writeFileAtomic(path.join(this.paths.profilesDir, `${r.profile.id}.json`), JSON.stringify(r.profile, null, 2) + "\n");
    this.reload();
    return r.profile;
  }

  deleteLocal(id: string): boolean {
    const file = path.join(this.paths.profilesDir, `${id}.json`);
    if (path.dirname(file) !== this.paths.profilesDir) return false;
    try {
      fs.unlinkSync(file);
    } catch {
      return false;
    }
    this.reload();
    return true;
  }

  // ---- Queries ----

  all(): CatalogEntry[] {
    return [...this.entries.values()].sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  getTool(id: string): { entry: CatalogEntry; tool: Tool } | undefined {
    const i = id.lastIndexOf("/");
    if (i <= 0) return undefined;
    const entry = this.entries.get(id.slice(0, i));
    const tool = entry?.profile.tools.find((t) => t.name === id.slice(i + 1));
    return entry && tool ? { entry, tool } : undefined;
  }

  categories(): (Category & { profiles: number })[] {
    const counts = new Map<string, number>();
    for (const e of this.entries.values()) for (const c of e.profile.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    const known = this.categoryList.map((c) => ({ ...c, profiles: counts.get(c.id) ?? 0 }));
    // Categories used by local profiles but not declared anywhere.
    for (const [id, n] of counts) {
      if (!known.some((c) => c.id === id)) known.push({ id, name: id, description: "", profiles: n });
    }
    return known;
  }

  lists(): ProfileList[] {
    return this.listList;
  }

  getList(id: string): ProfileList | undefined {
    return this.listList.find((l) => l.id === id);
  }

  inCategory(category: string): CatalogEntry[] {
    return this.all().filter((e) => e.profile.categories.includes(category));
  }

  search(query: string, opts: { category?: string; limit?: number } = {}): SearchHit[] {
    const terms = tokenize(query);
    const hits: SearchHit[] = [];
    for (const { profile } of this.entries.values()) {
      if (opts.category && !profile.categories.includes(opts.category)) continue;
      const profileText = [
        ...tokenize(profile.name),
        ...tokenize(profile.id),
        ...tokenize(profile.description),
        ...profile.categories.flatMap(tokenize),
      ];
      for (const tool of profile.tools) {
        let score = 0;
        let matched = 0;
        if (terms.length) {
          const strong = [...tokenize(tool.name), ...tokenize(tool.title)];
          const weak = tokenize(tool.description);
          for (const term of terms) {
            const like = (t: string) => (list: string[]) => list.some((w) => w === t || (t.length >= 3 && (w.startsWith(t) || (t.startsWith(w) && w.length >= 4))));
            const m = like(term);
            let s = 0;
            if (m(strong)) s += 3;
            if (m(weak)) s += 1;
            if (m(profileText)) s += 2;
            // A synonym ("message" for "direct") counts, a bit less than the word itself.
            if (!s && (SYNONYMS[term] ?? []).some((syn) => like(syn)(strong))) s += 2;
            else if (!s && (SYNONYMS[term] ?? []).some((syn) => like(syn)(weak))) s += 1;
            if (s) matched++;
            score += s;
          }
          if (!matched) continue;
          score *= matched / terms.length;
          // Prefer API tools (one small call) over reading pages.
          if (tool.action.kind === "http") score *= 1.3;
          if (tool.name === "open_path") score *= 0.6;
        }
        hits.push({ id: toolId(profile.id, tool.name), profileId: profile.id, profileName: profile.name, tool, auth: effectiveAuth(profile, tool), score });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, opts.limit ?? 10);
  }

  /** Tool ids a pin entry expands to. */
  expandPin(target: string): string[] {
    if (target.startsWith("list:")) {
      const list = this.getList(target.slice(5));
      return (list?.profiles ?? []).flatMap((p) => this.expandPin(p));
    }
    const entry = this.entries.get(target);
    if (entry) return entry.profile.tools.map((t) => toolId(entry.profile.id, t.name));
    return this.getTool(target) ? [target] : [];
  }

  /** True if `target` is a profile id, "list:<id>" or a tool id that exists. */
  pinTargetExists(target: string): boolean {
    if (target.startsWith("list:")) return Boolean(this.getList(target.slice(5)));
    return Boolean(this.entries.get(target) || this.getTool(target));
  }

  summary(entry: CatalogEntry, state: State): ProfileSummary {
    const p = entry.profile;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      version: p.version,
      source: entry.source,
      official: false,
      auth: p.auth,
      categories: p.categories,
      origins: p.origins,
      allowedHosts: p.allowedHosts,
      tools: p.tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        mutates: t.mutates,
        kind: t.action.kind,
        runsIn: effectiveAuth(p, t) === "none" ? ("gateway" as const) : ("browser" as const),
      })),
      approved: Boolean(state.approvals[p.id]?.site),
      pinned: state.pinned.includes(p.id),
    };
  }

  overview(url: string | undefined, state: State, info: { gatewayVersion: string; registryRepo?: string }): Overview {
    const all = this.all();
    return {
      gatewayVersion: info.gatewayVersion,
      registryUpdatedAt: this.registryUpdatedAt,
      registryRepo: info.registryRepo,
      matching: url ? all.filter((e) => originMatches(e.profile.origins, url)).map((e) => this.summary(e, state)) : [],
      local: all.filter((e) => e.source === "local").map((e) => this.summary(e, state)),
      categories: this.categoryList,
      lists: this.listList.map((l) => ({ ...l, pinned: state.pinned.includes(`list:${l.id}`) })),
    };
  }
}
