// Fills profile templates with tool arguments.
//
// Rules:
// - `{name}` is replaced by the argument. In URL paths it's percent-encoded.
// - `{+name}` is replaced without encoding slashes, for a whole path ("docs/intro?x=1").
// - A query parameter, header or form field whose template uses a missing argument is dropped.
// - In a JSON body, a string that is exactly "{name}" is replaced by the raw value (keeps numbers,
//   booleans, arrays). A key whose value uses a missing argument is dropped.
// - A query/form value `{ json: … }` is filled like a JSON body and sent as JSON text.
// - Missing optional arguments use the input schema's `default`, if it has one.
// - `{$uuid}`, `{$now}` and `{$rand:N}` become fresh values on every call (ids the page invents).
// - `{$cookie:x}`, `{$meta:x}` and `{$live:x}` are left untouched; the browser fills them with
//   fillBrowserPlaceholders() below.
// - A missing argument in the URL path is an error.

import type { FormAction, HttpAction, InputSchema, PageAction, ValueTemplate, WebMcpAction } from "./profile.js";

export type Args = Record<string, unknown>;

export interface ResolvedHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ResolvedFormAction {
  page: string;
  form: string;
  /** CSS selector -> value to put in it. */
  fields: Record<string, string>;
  submit?: string;
  waitFor?: string;
  read?: string;
  maxChars: number;
}

export interface ResolvedPageAction {
  url: string;
  waitFor?: string;
  read?: string;
  maxChars: number;
}

export class TemplateError extends Error {}

const PLACEHOLDER = /\{(\+?)([A-Za-z_][A-Za-z0-9_]*)\}/g;
const EXACT = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function stringify(v: unknown): string {
  if (Array.isArray(v)) return v.map(stringify).join(",");
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function has(args: Args, key: string): boolean {
  return args[key] !== undefined && args[key] !== null;
}

const GENERATED = /\{\$(uuid|now|rand:(\d{1,3}))\}/g;

function randomDigits(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = String(1 + (bytes[0]! % 9));
  for (let i = 1; i < n; i++) out += String(bytes[i]! % 10);
  return out;
}

/** {$uuid}, {$now} (ms timestamp) and {$rand:N} (N random digits): fresh values for each call. */
export function fillGenerated(template: string): string {
  return template.replace(GENERATED, (_m, kind: string, n?: string) =>
    kind === "uuid" ? globalThis.crypto.randomUUID() : kind === "now" ? String(Date.now()) : randomDigits(Math.max(1, Number(n))),
  );
}

/** Fills a template. Returns undefined if it uses an argument that's missing. */
export function fill(template: string, args: Args, encode?: (s: string) => string): string | undefined {
  let missing = false;
  const out = fillGenerated(template).replace(PLACEHOLDER, (_m, plus: string, key: string) => {
    if (!has(args, key)) {
      missing = true;
      return "";
    }
    const s = stringify(args[key]);
    // {+path}: a whole path, slashes kept (leading ones dropped so it stays on the same site).
    if (plus) return encodeURI(s.replace(/^[/\\]+/, "")).replace(/%25([0-9A-F]{2})/gi, "%$1");
    return encode ? encode(s) : s;
  });
  return missing ? undefined : out;
}

/** Checks required arguments and drops ones the schema doesn't define. */
export function checkArgs(input: InputSchema, args: Args | undefined): Args {
  const a = args ?? {};
  const missing = (input.required ?? []).filter((r) => !has(a, r));
  if (missing.length) throw new TemplateError(`Missing required argument(s): ${missing.join(", ")}`);
  const out: Args = {};
  for (const [k, schema] of Object.entries(input.properties)) {
    if (has(a, k)) out[k] = a[k];
    else if (schema && typeof schema === "object" && "default" in schema) out[k] = (schema as { default: unknown }).default;
  }
  return out;
}

export function resolveHttpRequest(action: HttpAction, args: Args): ResolvedHttpRequest {
  const base = fill(action.url, args, encodeURIComponent);
  if (base === undefined) throw new TemplateError(`Missing an argument used in the URL: ${action.url}`);
  const url = new URL(base);
  addQuery(url, action.query, args);

  const headers: Record<string, string> = {};
  for (const [k, t] of Object.entries(action.headers ?? {})) {
    const v = fill(t, args);
    if (v !== undefined) headers[k] = v;
  }

  let body: string | undefined;
  if (action.body) {
    if (action.body.encoding === "json") {
      body = JSON.stringify(fillJson(action.body.value, args) ?? null);
      headers["content-type"] ??= "application/json";
    } else {
      const form = new URLSearchParams();
      const value = (action.body.value ?? {}) as Record<string, unknown>;
      for (const [k, t] of Object.entries(value)) {
        const v = fillValue(t, args);
        if (v !== undefined) form.set(k, v);
      }
      body = form.toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    }
  }
  return { method: action.method, url: url.toString(), headers, body };
}

function isJsonValue(t: unknown): t is { json: unknown } {
  return t !== null && typeof t === "object" && !Array.isArray(t) && "json" in t && Object.keys(t).length === 1;
}

/** Fills a query or form value. Returns undefined when it should be left out. */
function fillValue(t: ValueTemplate | unknown, args: Args): string | undefined {
  if (typeof t === "string") return fill(t, args);
  if (isJsonValue(t)) {
    const v = fillJson(t.json, args);
    return v === undefined ? undefined : JSON.stringify(v);
  }
  return t === undefined || t === null ? undefined : stringify(t);
}

function addQuery(url: URL, query: Record<string, ValueTemplate> | undefined, args: Args): void {
  for (const [k, t] of Object.entries(query ?? {})) {
    const v = fillValue(t, args);
    if (v !== undefined) url.searchParams.set(k, v);
  }
}

export function resolvePageAction(action: PageAction, args: Args): ResolvedPageAction {
  const base = fill(action.url, args, encodeURIComponent);
  if (base === undefined) throw new TemplateError(`Missing an argument used in the URL: ${action.url}`);
  const url = new URL(base);
  addQuery(url, action.query, args);
  return { url: url.toString(), waitFor: action.waitFor, read: action.read, maxChars: action.maxChars ?? 20_000 };
}

const DROP = Symbol("drop");

function fillJson(value: unknown, args: Args): unknown {
  const r = fillJsonInner(value, args);
  return r === DROP ? undefined : r;
}

function fillJsonInner(value: unknown, args: Args): unknown {
  if (typeof value === "string") {
    const exact = EXACT.exec(value);
    if (exact) return has(args, exact[1]!) ? args[exact[1]!] : DROP;
    const v = fill(value, args);
    return v === undefined ? DROP : v;
  }
  if (Array.isArray(value)) {
    return value.map((v) => fillJsonInner(v, args)).filter((v) => v !== DROP);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = fillJsonInner(v, args);
      if (r !== DROP) out[k] = r;
    }
    return out;
  }
  return value;
}

export function resolveFormAction(action: FormAction, args: Args): ResolvedFormAction {
  const page = fill(action.page, args, encodeURIComponent);
  if (page === undefined) throw new TemplateError(`Missing an argument used in the page URL: ${action.page}`);
  const fields: Record<string, string> = {};
  for (const [param, selector] of Object.entries(action.fields)) {
    if (has(args, param)) fields[selector] = stringify(args[param]);
  }
  return {
    page,
    form: action.form,
    fields,
    submit: action.submit,
    waitFor: action.result?.waitFor,
    read: action.result?.read,
    maxChars: action.result?.maxChars ?? 20_000,
  };
}

export function resolveWebMcpPage(action: WebMcpAction, args: Args): string {
  const page = fill(action.page, args, encodeURIComponent);
  if (page === undefined) throw new TemplateError(`Missing an argument used in the page URL: ${action.page}`);
  return page;
}

/** True if `url`'s host is one of `allowedHosts`. */
export function hostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && allowedHosts.includes(u.host);
  } catch {
    return false;
  }
}

// ---- Browser placeholders ---------------------------------------------------
// Run inside the extension, right before a browser-session request is sent.

const BROWSER_RE = /\{\$(cookie|meta|live):([^}]+)\}/g;

/** "cookie:csrftoken", "live:fb_dtsg", … used in a request. */
export function browserPlaceholders(req: ResolvedHttpRequest): string[] {
  const found = new Set<string>();
  const scan = (s: string | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(BROWSER_RE)) found.add(`${m[1]}:${m[2]}`);
  };
  try {
    new URL(req.url).searchParams.forEach((v) => scan(v));
  } catch {
    // bad URL; the fetch will fail anyway
  }
  for (const v of Object.values(req.headers)) scan(v);
  if (req.body) {
    scan(req.body);
    try {
      new URLSearchParams(req.body).forEach((v) => scan(v));
    } catch {
      // not form-encoded
    }
  }
  return [...found];
}

/**
 * Fills {$cookie:…}/{$meta:…}/{$live:…} from `values` (keyed "kind:name"). A header, query
 * parameter, form field or JSON key whose placeholder has no value is left out, and listed in `missing`.
 */
export function fillBrowserPlaceholders(
  req: ResolvedHttpRequest,
  values: Record<string, string | undefined>,
): { request: ResolvedHttpRequest; missing: string[] } {
  const missing = new Set<string>();
  const sub = (s: string, escape: (v: string) => string = (v) => v): string | undefined => {
    let gone = false;
    const out = s.replace(BROWSER_RE, (_m, kind: string, name: string) => {
      const v = values[`${kind}:${name}`];
      if (v === undefined) {
        missing.add(`${kind}:${name}`);
        gone = true;
        return "";
      }
      return escape(v);
    });
    return gone ? undefined : out;
  };

  const url = new URL(req.url);
  for (const [k, v] of [...url.searchParams.entries()]) {
    if (!v.includes("{$")) continue;
    const filled = sub(v, jsonSafe(v));
    if (filled === undefined) url.searchParams.delete(k);
    else url.searchParams.set(k, filled);
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const filled = v.includes("{$") ? sub(v) : v;
    if (filled !== undefined) headers[k] = filled;
  }

  let body = req.body;
  if (body?.includes("{$") || body?.includes("%7B%24")) {
    const type = Object.entries(req.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    if (/x-www-form-urlencoded/i.test(type)) {
      const form = new URLSearchParams(body);
      for (const [k, v] of [...form.entries()]) {
        if (!v.includes("{$")) continue;
        const filled = sub(v, jsonSafe(v));
        if (filled === undefined) form.delete(k);
        else form.set(k, filled);
      }
      body = form.toString();
    } else if (/json/i.test(type)) {
      try {
        body = JSON.stringify(fillJsonPlaceholders(JSON.parse(body), sub));
      } catch {
        body = sub(body) ?? body;
      }
    } else {
      body = sub(body) ?? body;
    }
  }
  return { request: { ...req, url: url.toString(), headers, body }, missing: [...missing] };
}

/** Inside a value that is itself JSON text, inserted values must be JSON-escaped. */
function jsonSafe(container: string): (v: string) => string {
  return /^\s*[[{]/.test(container) ? (v) => JSON.stringify(v).slice(1, -1) : (v) => v;
}

function fillJsonPlaceholders(value: unknown, sub: (s: string) => string | undefined): unknown {
  if (typeof value === "string") return value.includes("{$") ? (sub(value) ?? DROP) : value;
  if (Array.isArray(value)) return value.map((v) => fillJsonPlaceholders(v, sub)).filter((v) => v !== DROP);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = fillJsonPlaceholders(v, sub);
      if (r !== DROP) out[k] = r;
    }
    return out;
  }
  return value;
}

// ---- Signed-out detection ---------------------------------------------------

const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sign_in|accounts\/login|auth\/login|session\/new|sessions\/new|i\/flow\/login|uas\/login|checkpoint)(\/|\?|#|$)/i;
const SIGNED_OUT_TEXT =
  /logged[ _-]?out|login[ _-]?required|not[ _-]?logged[ _-]?in|please (log|sign) ?in|unauthenticated|authentication required|"require_login"\s*:\s*true|session (has )?expired|sign in to continue/i;

/** A sign-in page address, e.g. https://www.instagram.com/accounts/login/?next=… */
export function isLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOGIN_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

/** Does a site's answer say the user isn't signed in? */
export function looksSignedOut(r: { status: number; url: string; body: string }): boolean {
  if (isLoginUrl(r.url)) return true;
  if (r.status === 401) return true;
  // Only look at the text of errors or short replies: an article may mention "logged out".
  const errorish = r.status >= 400 || r.body.length < 4000 || /^\s*\{\s*"errors"\s*:/.test(r.body);
  return errorish && SIGNED_OUT_TEXT.test(r.body.slice(0, 4000));
}

// ---- Blocked / rate-limited detection --------------------------------------

/** Pages a site sends you to when it suspects automation or has limited the account. */
const BLOCK_PATH =
  /\/(challenge|checkpoint|captcha|sorry|account\/access|account\/locked|accounts\/suspended|suspended|security-check|blocked|restricted)(\/|\?|#|$)|\/cdn-cgi\/challenge-platform\//i;
/** What sites say when they rate-limit or suspect a bot. */
const BLOCK_TEXT =
  /too many requests|rate[ _-]?limit(ed| exceeded)|unusual (traffic|activity)|automated (queries|requests|behaviou?r)|might be automated|are you a (robot|human)|verify (that )?you('| a)re (a )?human|complete the (security check|captcha)|"feedback_required"|"checkpoint_required"|"spam"\s*:\s*true|action (was )?blocked|temporarily (blocked|restricted|locked|limited)|please wait a few minutes before you try again|we limit how often|suspicious activity|just a moment\.\.\.|attention required! \| cloudflare/i;

/**
 * Does a site's answer say it's rate-limiting the user or suspects automation?
 * Returns a short reason, or undefined. Checked before signed-out detection: a security
 * check isn't fixed by signing in again.
 *
 * `body` is the raw reply for API calls, or the visible text for pages (`page: true`).
 */
export function looksBlocked(r: { status: number; url: string; body: string; page?: boolean }): string | undefined {
  if (r.status === 429) return "the site said there were too many requests (HTTP 429)";
  if (BLOCK_PATH.test(safePath(r.url))) return `the site sent a security check page (${r.url})`;
  // Only read error replies, short JSON replies and short pages: an article may mention "captcha",
  // and an ordinary page's HTML can contain captcha scripts.
  const head = r.body.slice(0, 6000);
  const readIt = r.status >= 400 || (r.page ? r.body.length < 3000 : r.body.length < 6000 && /^\s*[[{]/.test(head));
  const m = readIt ? BLOCK_TEXT.exec(head) : null;
  if (m) return `the site said "${m[0].replace(/"/g, "")}"`;
  return undefined;
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return "";
  }
}

/** Seconds from a Retry-After header (seconds or an HTTP date), or undefined. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const s = Number(header.trim());
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(header);
  return Number.isFinite(t) && t > now ? t - now : undefined;
}
