// Paces what AnyMCP does on each site, so the user's accounts don't look like a bot.
//
// - Calls to a site are spaced out with a random gap, and capped per minute, hour and day.
// - Actions that change data (posting, liking, following, messaging) get a much longer gap and
//   their own hourly and daily caps, even when the user chose "always allow".
// - Social networks and other sites known to limit automated accounts get the strict pace.
// - When a site pushes back (HTTP 429, a captcha or security check, "unusual activity"), AnyMCP
//   pauses that site: Retry-After if the site gave one, else 15 min, then 1 h, 6 h, 24 h.
// - Several failed calls in a row pause the site for 10 minutes: hammering errors looks botty.
//
// State lives in ~/.anymcp/pacing.json so every AI app's gateway shares the same limits.

import fs from "node:fs";
import path from "node:path";
import { isStrictSite, siteKey } from "@anymcp/shared";
import { writeFileAtomic, type Paths } from "./config.js";

export { isStrictSite, siteKey };

export type Pace = "strict" | "normal" | "relaxed";
export type PaceSetting = Pace | "off";

export interface Limits {
  /** Random gap between any two calls to the site (ms). */
  gap: [number, number];
  perMinute: number;
  perHour: number;
  perDay: number;
  /** Random gap between two actions that change data (ms). */
  actGap: [number, number];
  actsPerHour: number;
  actsPerDay: number;
}

export const LIMITS: Record<Pace, Limits> = {
  strict: { gap: [3_000, 8_000], perMinute: 8, perHour: 150, perDay: 800, actGap: [30_000, 75_000], actsPerHour: 10, actsPerDay: 40 },
  normal: { gap: [800, 2_500], perMinute: 25, perHour: 600, perDay: 4_000, actGap: [8_000, 20_000], actsPerHour: 40, actsPerDay: 200 },
  relaxed: { gap: [150, 500], perMinute: 60, perHour: 2_000, perDay: 20_000, actGap: [2_000, 5_000], actsPerHour: 120, actsPerDay: 1_000 },
};

/** Longest wait AnyMCP does for the AI; past this it says when to come back instead. */
export const MAX_WAIT_MS = 90_000;
const BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const ERRORS_BEFORE_PAUSE = 4;
const ERROR_PAUSE_MS = 10 * 60_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const ORDER: Pace[] = ["relaxed", "normal", "strict"];
const stricter = (a: Pace, b: Pace): Pace => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/** The pace AnyMCP picks for a site before any setting from the user. */
export function defaultPace(site: string, auth: string, profilePace?: Pace): Pace {
  const base: Pace = isStrictSite(site) ? "strict" : auth === "none" ? "relaxed" : "normal";
  // A profile can ask for more care, never less.
  return profilePace ? stricter(base, profilePace) : base;
}

// ---- State ------------------------------------------------------------------

interface SiteState {
  /** Call times in the last hour. */
  calls: number[];
  /** Calls per hour (key: hours since 1970), last 24 hours. */
  hours: Record<string, number>;
  /** Times of actions that changed data, last 24 hours. */
  acts: number[];
  last?: number;
  lastAct?: number;
  /** Failed calls in a row. */
  errors?: number;
  pausedUntil?: number;
  pauseReason?: string;
  /** Times the site pushed back in the last day; each one doubles the pause. */
  strikes?: number;
  lastStrike?: number;
}

interface PaceFile {
  sites: Record<string, SiteState>;
  /** The user's choice per site. */
  overrides: Record<string, PaceSetting>;
}

const SETTINGS: PaceSetting[] = ["strict", "normal", "relaxed", "off"];

function pacingFile(paths: Paths): string {
  return path.join(paths.home, "pacing.json");
}

function load(paths: Paths): PaceFile {
  try {
    const raw = JSON.parse(fs.readFileSync(pacingFile(paths), "utf8")) as Partial<PaceFile>;
    const overrides: Record<string, PaceSetting> = {};
    for (const [k, v] of Object.entries(raw.overrides ?? {})) if (SETTINGS.includes(v)) overrides[k] = v;
    return { sites: raw.sites && typeof raw.sites === "object" ? raw.sites : {}, overrides };
  } catch {
    return { sites: {}, overrides: {} };
  }
}

function save(paths: Paths, f: PaceFile): void {
  writeFileAtomic(pacingFile(paths), JSON.stringify(f) + "\n");
}

function siteState(f: PaceFile, site: string, now: number): SiteState {
  const s = (f.sites[site] ??= { calls: [], hours: {}, acts: [] });
  s.calls = (s.calls ?? []).filter((t) => t > now - HOUR);
  s.acts = (s.acts ?? []).filter((t) => t > now - DAY);
  const oldest = Math.floor((now - DAY) / HOUR);
  s.hours = Object.fromEntries(Object.entries(s.hours ?? {}).filter(([h]) => Number(h) > oldest));
  if (s.pausedUntil && s.pausedUntil <= now) {
    delete s.pausedUntil;
    delete s.pauseReason;
  }
  if (s.lastStrike && s.lastStrike < now - DAY) {
    delete s.strikes;
    delete s.lastStrike;
  }
  return s;
}

// ---- Messages ---------------------------------------------------------------

export class PaceError extends Error {}

function inWords(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} seconds`;
  if (min < 90) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function pausedMessage(site: string, until: number, reason: string, now: number): string {
  return (
    `AnyMCP has paused ${site} until ${clock(until)} (${inWords(until - now)}) to protect the user's account: ${reason}. ` +
    `Don't use ${site} until then, and don't work around the pause with the browser tools or another tool: that is ` +
    `what gets accounts restricted. Tell the user. If the site showed a check (captcha, "confirm it's you"), they ` +
    `should clear it in Chrome; once they have, they can run \`anymcp resume ${site}\` to continue sooner.`
  );
}

// ---- Pacer ------------------------------------------------------------------

export interface PacerDeps {
  paths: Paths;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
}

export interface PaceRequest {
  /** "none" for public APIs, "browser-session" for anything signed in or in the browser. */
  auth: string;
  /** Changes data: posting, liking, following, messaging, buying, deleting. */
  acts?: boolean;
  profilePace?: Pace;
  /** Tells the AI app the call is still running while AnyMCP waits. */
  progress?: (message: string) => void;
}

export interface Outcome {
  /** Why the site seems to be limiting the user (from looksBlocked). */
  blocked?: string;
  /** From the site's Retry-After header. */
  retryAfterMs?: number;
  /** False when the call failed (HTTP error). */
  ok: boolean;
}

export interface SiteStatus {
  site: string;
  pace: PaceSetting;
  chosenByUser: boolean;
  callsLastHour: number;
  callsToday: number;
  actionsToday: number;
  pausedUntil?: number;
  pauseReason?: string;
}

export class Pacer {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly deps: PacerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
  }

  paceOf(site: string, auth: string, profilePace?: Pace): { pace: PaceSetting; chosenByUser: boolean } {
    const o = load(this.deps.paths).overrides[site];
    return o ? { pace: o, chosenByUser: true } : { pace: defaultPace(site, auth, profilePace), chosenByUser: false };
  }

  /**
   * Waits until it's fine to call the site, then records the call. Throws PaceError when the
   * site is paused, a cap is reached, or the wait would be too long.
   * Calls to the same site from this process run one at a time.
   */
  async before(url: string, req: PaceRequest): Promise<void> {
    const site = siteKey(url);
    const prev = this.queues.get(site) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.queues.set(site, tail);
    await prev;
    try {
      await this.wait(site, req);
    } finally {
      release();
      if (this.queues.get(site) === tail) this.queues.delete(site);
    }
  }

  private async wait(site: string, req: PaceRequest): Promise<void> {
    const now = this.now();
    const f = load(this.deps.paths);
    const s = siteState(f, site, now);
    const pace = f.overrides[site] ?? defaultPace(site, req.auth, req.profilePace);

    if (s.pausedUntil) throw new PaceError(pausedMessage(site, s.pausedUntil, s.pauseReason ?? "it was limiting requests", now));
    if (pace === "off") return this.record(site, req.acts);

    const L = LIMITS[pace];
    const change = `The user can change this with \`anymcp pace ${site} <strict|normal|relaxed>\`.`;
    if (req.acts) {
      const lastHour = s.acts.filter((t) => t > now - HOUR);
      if (s.acts.length >= L.actsPerDay) {
        throw new PaceError(
          `AnyMCP stopped: ${s.acts.length} actions that change data on ${site} in the last 24 hours, the most it does in a day ` +
            `(${pace} pace). Bulk actions (following, liking, messaging or posting a lot) are what gets accounts restricted. ` +
            `Next one possible in ${inWords(s.acts[0]! + DAY - now)}. Tell the user. ${change}`,
        );
      }
      if (lastHour.length >= L.actsPerHour) {
        throw new PaceError(
          `AnyMCP stopped: ${lastHour.length} actions that change data on ${site} in the last hour (${pace} pace allows ` +
            `${L.actsPerHour}). Try again in ${inWords(lastHour[0]! + HOUR - now)}, or tell the user. ${change}`,
        );
      }
    }
    const today = Object.values(s.hours).reduce((a, b) => a + b, 0);
    if (today >= L.perDay) {
      throw new PaceError(`AnyMCP stopped: ${today} calls to ${site} in the last 24 hours (${pace} pace allows ${L.perDay}). Tell the user. ${change}`);
    }
    if (s.calls.length >= L.perHour) {
      throw new PaceError(
        `AnyMCP stopped: ${s.calls.length} calls to ${site} in the last hour (${pace} pace allows ${L.perHour}). ` +
          `Try again in ${inWords(s.calls[0]! + HOUR - now)}, or tell the user. ${change}`,
      );
    }

    const between = ([lo, hi]: [number, number]) => lo + this.random() * (hi - lo);
    let wait = 0;
    if (s.last) wait = Math.max(wait, s.last + between(L.gap) - now);
    if (req.acts && s.lastAct) wait = Math.max(wait, s.lastAct + between(L.actGap) - now);
    const lastMinute = s.calls.filter((t) => t > now - 60_000);
    if (lastMinute.length >= L.perMinute) wait = Math.max(wait, lastMinute[lastMinute.length - L.perMinute]! + 60_000 - now);

    if (wait > MAX_WAIT_MS) {
      throw new PaceError(
        `AnyMCP is pacing ${site} (${pace} pace${req.acts ? ", and this changes data" : ""}): the next call is possible in ` +
          `${inWords(wait)}. Do something else meanwhile or try again then. Don't work around this with the browser tools.`,
      );
    }
    if (wait > 0) {
      const why = req.acts ? "actions that change data are spaced out" : "calls are spaced out";
      let left = wait;
      while (left > 0) {
        req.progress?.(`Pacing ${site}: ${why} so it doesn't look automated (${Math.ceil(left / 1000)}s)`);
        const step = Math.min(left, 10_000);
        await this.sleep(step);
        left -= step;
      }
    }
    this.record(site, req.acts);
  }

  private record(site: string, acts?: boolean): void {
    const now = this.now();
    const f = load(this.deps.paths); // re-read: another AI app may have written meanwhile
    const s = siteState(f, site, now);
    s.calls.push(now);
    const h = String(Math.floor(now / HOUR));
    s.hours[h] = (s.hours[h] ?? 0) + 1;
    s.last = now;
    if (acts) {
      s.acts.push(now);
      s.lastAct = now;
    }
    save(this.deps.paths, f);
  }

  /**
   * Notes how a call went. Returns a message for the AI when the site is now paused.
   */
  after(url: string, outcome: Outcome): string | undefined {
    const site = siteKey(url);
    const now = this.now();
    const f = load(this.deps.paths);
    const s = siteState(f, site, now);
    let note: string | undefined;
    if (outcome.blocked) {
      s.strikes = (s.strikes ?? 0) + 1;
      s.lastStrike = now;
      const backoff = BACKOFF_MS[Math.min(s.strikes - 1, BACKOFF_MS.length - 1)]!;
      const ms = Math.max(outcome.retryAfterMs ?? 0, outcome.retryAfterMs ? 60_000 : backoff);
      s.pausedUntil = Math.max(s.pausedUntil ?? 0, now + ms);
      s.pauseReason = outcome.blocked;
      s.errors = 0;
      note = pausedMessage(site, s.pausedUntil, outcome.blocked, now);
      this.deps.log?.(`Paused ${site} for ${inWords(ms)}: ${outcome.blocked}`);
    } else if (!outcome.ok) {
      s.errors = (s.errors ?? 0) + 1;
      if (s.errors >= ERRORS_BEFORE_PAUSE) {
        s.pausedUntil = now + ERROR_PAUSE_MS;
        s.pauseReason = `${s.errors} calls in a row failed, and repeating failing requests looks automated`;
        s.errors = 0;
        note =
          pausedMessage(site, s.pausedUntil, s.pauseReason, now) +
          " The tool may be out of date: next time, do the task once with the browser tools so AnyMCP can fix it.";
        this.deps.log?.(`Paused ${site} for 10 minutes after repeated failures.`);
      }
    } else {
      s.errors = 0;
    }
    save(this.deps.paths, f);
    return note;
  }

  /** Is the site paused right now? The message to give the AI, or undefined. */
  pausedMessage(url: string): string | undefined {
    const site = siteKey(url);
    const now = this.now();
    const s = siteState(load(this.deps.paths), site, now);
    return s.pausedUntil ? pausedMessage(site, s.pausedUntil, s.pauseReason ?? "it was limiting requests", now) : undefined;
  }

  status(): SiteStatus[] {
    const now = this.now();
    const f = load(this.deps.paths);
    const sites = new Set([...Object.keys(f.sites), ...Object.keys(f.overrides)]);
    return [...sites].sort().map((site) => {
      const s = siteState(f, site, now);
      const chosen = f.overrides[site];
      return {
        site,
        pace: chosen ?? defaultPace(site, "browser-session"),
        chosenByUser: Boolean(chosen),
        callsLastHour: s.calls.length,
        callsToday: Object.values(s.hours).reduce((a, b) => a + b, 0),
        actionsToday: s.acts.length,
        pausedUntil: s.pausedUntil,
        pauseReason: s.pauseReason,
      };
    });
  }
}

/** Sets the user's pace for a site; "auto" goes back to AnyMCP's choice. */
export function setPace(paths: Paths, site: string, setting: PaceSetting | "auto"): string {
  const key = siteKey(site);
  const f = load(paths);
  if (setting === "auto") delete f.overrides[key];
  else f.overrides[key] = setting;
  save(paths, f);
  return key;
}

/** Ends a pause early (after the user cleared the site's check). Clears the strike count too. */
export function resumeSite(paths: Paths, site: string): { site: string; wasPaused: boolean } {
  const key = siteKey(site);
  const f = load(paths);
  const s = f.sites[key];
  const wasPaused = Boolean(s?.pausedUntil && s.pausedUntil > Date.now());
  if (s) {
    delete s.pausedUntil;
    delete s.pauseReason;
    delete s.strikes;
    delete s.lastStrike;
    s.errors = 0;
    save(paths, f);
  }
  return { site: key, wasPaused };
}

export function isPaceSetting(v: string): v is PaceSetting | "auto" {
  return v === "auto" || (SETTINGS as string[]).includes(v);
}
