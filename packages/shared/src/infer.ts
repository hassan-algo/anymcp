// Turns activity recorded in a browser tab into draft tools.
//
// Handles plain REST/JSON APIs, standard GraphQL, "persisted" GraphQL (Facebook/Instagram/Threads
// `doc_id` + friendly name, X `/graphql/<id>/<Name>`, Apollo `operationName`), form posts, and
// page visits (for sites without an API).
//
// Personal data is kept out by construction:
// - Values the user typed or that identify them become parameters (never stored).
// - Login and anti-forgery codes become {$live:…}, {$cookie:…} or {$meta:…} placeholders that the
//   browser fills at call time.
// - Only harmless constants (true/false, small numbers, ENUM_LIKE words, public query ids) are kept.
// privacy.ts then scans whatever is left.

import type { HttpAction, InputSchema, PageAction, Tool, ValueTemplate } from "./profile.js";

export interface CapturedHeader {
  name: string;
  /** Only present when the recorder judged the value harmless (e.g. "XMLHttpRequest"). */
  value?: string;
  /** "cookie:<name>" or "meta:<name>" when the value equalled one; "live" for anything else. */
  ref?: string;
}

export interface CapturedRequest {
  /** "navigation" = the user opened a page (top frame); default "fetch" = an API call. */
  kind?: "fetch" | "navigation";
  method: string;
  url: string;
  requestBody?: string;
  requestContentType?: string;
  status: number;
  responseContentType?: string;
  /** First few KB of the response, used to guess a `pick` path. */
  responseSample?: string;
  headers?: CapturedHeader[];
  /** "query:<key>" / "body:<key>" -> "cookie:<name>" / "meta:<name>" when the value equalled one. */
  refs?: Record<string, string>;
  /** When it happened (ms since epoch). */
  at?: number;
  /** While learning: caused by a click/fill ("action") or by opening a page ("navigate"). */
  trigger?: "action" | "navigate";
}

export interface InferResult {
  tools: Tool[];
  allowedHosts: string[];
  /** Things the user should know. */
  notes: string[];
  /**
   * Per tool name: id-like values seen for its parameters in this recording (never free text), and
   * whether a click/fill caused it. For telling the AI right away; never stored in a profile.
   */
  details: Record<string, { examples: Record<string, unknown>; trigger?: "action" | "navigate" }>;
}

const NOISE_HOSTS =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|googleadservices|facebook\.net|connect\.facebook|segment\.(io|com)|sentry\.io|sentry-cdn|hotjar|mixpanel|amplitude|intercom|datadoghq|browser-intake|newrelic|nr-data|clarity\.ms|cloudflareinsights|bugsnag|fullstory|launchdarkly|stripe\.network|braze|branch\.io|appsflyer|adjust\.com|optimizely|quantserve|scorecardresearch|taboola|outbrain|criteo|tiktokw?\.?analytics)/i;
/** File servers: never API calls worth a tool. */
const CDN_HOSTS =
  /(^|[.-])(static|cdn|cdn\d*|assets?|img|images?|media|fonts?|scontent|video|thumbs?|avatars?|emoji|stickers)[.-]|cdninstagram\.com|fbcdn\.net|akamaihd\.net|akamaized\.net|cloudfront\.net|gstatic\.com|twimg\.com|googleusercontent\.com|ytimg\.com|ggpht\.com|redditmedia\.com|redditstatic\.com|licdn\.com|pinimg\.com|tiktokcdn|zdassets/i;
const NOISE_PATH =
  /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|map|mp4|webm|m3u8|ts|mp3|wasm)$|\/(collect|beacon|track|tracking|telemetry|metrics|log|logs|logging|log_event|events?|analytics|ping|heartbeat|pixel|bz|falco|csp-report|report|rum|vitals|btmanifest|manifest\.json|service-?worker)(\/|$)|\/ajax\/(bz|bulk-route-definitions|qm|webstorage)|\/(sodar|gampad|pagead|adserver|ads?|prebid|bid|consent|cmp|gdpr|tcf)(\/|$)/i;
const CACHE_BUSTERS = /^(_|t|ts|timestamp|cb|cachebuster|nocache|rnd|random|_rsc|_t|__a_ts)$|^utm_|^(fbclid|gclid|igsh|igshid|mc_cid|mc_eid|ref_src|si|_hsenc|_hsmi)$/i;
/** Names of login / anti-forgery / session fields: filled live by the browser. */
const SESSION_KEYS =
  /(csrf|xsrf|token|secret|signature|^sig$|session|api[_-]?key|^key$|auth|nonce|^fb_dtsg|^lsd$|^jazoest$|^av$|^__|^dpr$|^x-ig-|^x-fb-|^x-asbd|^x-instagram|^x-twitter|^x-client-transaction|^x-goog|^x-requested-with$|^x-guest-token|^x-li-|^x-restli|^x-amz|^x-api|^x-app|^x-device|^x-csrf|^x-xsrf|claim|^device_?id$|^client_?id$|^request_?id$|^trace|^x-b3|^traceparent$|^baggage$)/i;
/** Background plumbing pages do on their own (ads, logging, promos, presence…): never useful tools. */
const NOISE_OP =
  /(^|_)(qp|quick_promotion|aymt|megaphone|nux|logging|log|presence|bootloader|interstitial|banner|tooltip|upsell|experiment|gating|gate|feature_limits|ad_tools|ads_pool|boost|ad_account|billing|prepaid|unified_cvc|cvc|falco|pixel|beacon|telemetry|impression|seen_state|heartbeat|keep_alive|prefetch|preload|route_definition|navigation|account_switcher|automatic_previews|partnership|school_partner|golden_window|aymt|iap|eligib|onboarding|survey|rating_prompt|sso|fr_cookie|cookie|consent|captcha|web_vitals|bug_report)(_|$)/i;
/** Calls that hand out credentials or touch passwords: never turned into tools. */
const SENSITIVE = /access_?token|refresh_?token|password|passwd|two_factor|2fa|otp|recovery_code|api_?key|secret/i;
const NOISE_PATH_EXTRA = /\/ajax\/(navigation|route-definition|bootloader-endpoint|haste-response|bulk-route-definitions)|\/logging_client_events|\/video\/unified_cvc|\/api\/v1\/web\/(get_ruling_for_content|sync|log)/i;
/** Ids the page invents for each request: AnyMCP makes a fresh one per call. */
const GENERATED_KEYS =
  /^(offline_threading_id|client_context|client_mutation_id|mutation_id|idempotency_?key|client_request_id|upload_id|otid|client_message_id|client_id_for_dedup|dedup_key|mutation_token|request_uuid|client_trace_id)$/i;

/** Fields that name a persisted query: kept as fixed values. */
const OP_LITERAL = /^(doc_id|docid|query_id|queryid|query_hash|fb_api_req_friendly_name|fb_api_caller_class|operationname|server_timestamps|extensions|persistedquery)$/i;
/** Fields that may keep a recorded default even when lowercase. */
const DEFAULTABLE = /^(\w*attribution|\w*_surface|\w*_source|entry_?point|entrypoint|format|sort|sort_by|order|order_by|type|lang|locale|hl|view|include|fields|expand|mode|kind|output|platform|client|surface|source|render_surface|tab|filter|scope|section|first|count|limit|per_page|page_size|size)$/i;
/** Header names never turned into tool headers. */
const SKIP_HEADERS =
  /^(content-type|content-length|accept|accept-encoding|accept-language|user-agent|referer|referrer|origin|cookie|host|connection|keep-alive|cache-control|pragma|priority|te|upgrade-insecure-requests|dnt|if-none-match|if-modified-since|range|sec-.*)$/i;
const VERSION_SEG = /^(api|v\d+(\.\d+)?|rest|graphql|json|ajax|_api|internal|public|web|i)$/i;
const VERB_SEGS = /^(search|query|login|logout|like|unlike|follow|unfollow|subscribe|vote|upvote|star|send|submit|upload|check|validate|refresh|lookup|autocomplete|suggest|typeahead|preview|export|import)$/i;
const ARRAY_KEYS = ["items", "data", "results", "hits", "entries", "records", "list", "children", "posts", "rows", "edges", "nodes"];
/** Common fixed page names: not merged into a parameter when visiting pages. */
const STATIC_PAGES =
  /^(about|pricing|login|signin|sign-in|signup|sign-up|register|logout|explore|settings|account|accounts|help|support|blog|docs|search|home|contact|terms|privacy|careers|jobs|news|reels|reel|direct|inbox|messages|notifications|feed|trending|popular|new|top|latest|discover|watch|shop|store|cart|checkout|orders|profile|dashboard|tags|topics|categories|users|people|groups|events|p|r|u|c|t)$/i;

// ---- Small helpers ----------------------------------------------------------

function isIdSegment(seg: string): boolean {
  let s = seg;
  try {
    s = decodeURIComponent(seg);
  } catch {
    // keep raw
  }
  return (
    /^\d+$/.test(s) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9a-f]{12,}$/i.test(s) ||
    (/^[A-Za-z0-9_-]{16,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) ||
    s.includes("@")
  );
}

/** Looks like a slug a person chose (username, handle): dots, underscores, digits. Pages only. */
function isPersonalSlug(seg: string): boolean {
  return !STATIC_PAGES.test(seg) && (/[._]/.test(seg) || (/\d/.test(seg) && /[a-z]/i.test(seg)) || seg.length > 24);
}

/** In API addresses only a dotted name (alice.b, not a file like items.json) counts. */
function isPersonalApiSlug(seg: string): boolean {
  return !STATIC_PAGES.test(seg) && /^[\w-]+\.[\w.-]+$/.test(seg) && !/\.(json|xml|php|aspx?|html?|jsp|cgi|rss|atom|txt|csv|js|css)$/i.test(seg);
}

function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|us)$/.test(word)) return word;
  if (/ses$|xes$|ches$|shes$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * Makes a valid, unique snake_case name. Tool names need at least 2 characters; parameter
 * names (any `taken` set other than tool names) may be 1 character, e.g. "q".
 */
export function uniqueName(base: string, taken: Set<string>, fallback = "tool", minLength = fallback === "tool" || fallback === "form" ? 2 : 1): string {
  let name = snake(base) || fallback;
  if (!/^[a-z]/.test(name)) name = `${fallback}_${name}`;
  name = name.slice(0, 60);
  if (name.length < minLength) name = `${name}_${fallback}`;
  let out = name;
  for (let i = 2; taken.has(out); i++) out = `${name}_${i}`;
  taken.add(out);
  return out;
}

function titleFromName(name: string): string {
  const t = name.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function jsonType(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null || v === undefined) return "string";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return "object";
  return "string";
}

function guessPick(sample: string | undefined): string | undefined {
  if (!sample) return undefined;
  try {
    const v = JSON.parse(sample.replace(/^\s*(for\s*\(;;\);|while\s*\(1\);|\)\]\}'\s*,?)/, ""));
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const arrays = Object.entries(v).filter(([, x]) => Array.isArray(x));
      if (arrays.length === 1 && ARRAY_KEYS.includes(arrays[0]![0].toLowerCase())) return arrays[0]![0];
    }
  } catch {
    // Sample was cut off or isn't JSON.
  }
  return undefined;
}

function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!/^[[{]/.test(t)) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function looksLikeToken(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return (
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(v) ||
    /^(?=.*[a-f])[0-9a-f]{20,}$/i.test(v) || // hex, not a long numeric id
    (/^[A-Za-z0-9_:+/=.-]{20,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v))
  );
}

/** A constant that's safe to keep in a shared profile. */
function isHarmless(v: unknown, lowercaseOk = false): boolean {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isInteger(v) ? Math.abs(v) <= 1000 : Math.abs(v) <= 100;
  if (typeof v === "string") {
    if (v === "" || /^(true|false|null|undefined)$/i.test(v)) return true;
    if (/^-?\d{1,3}(\.\d+)?$/.test(v)) return true;
    if (/^[A-Z][A-Z0-9_]{1,40}$/.test(v)) return true; // ENUM_LIKE
    if (/^[A-Z][a-zA-Z]{2,30}$/.test(v) && /[a-z]/.test(v) && /[A-Z].*[A-Z]/.test(v)) return true; // RelayModern
    return lowercaseOk && /^[a-z][a-z_-]{0,30}$/.test(v);
  }
  if (Array.isArray(v)) return v.length <= 20 && v.every((x) => isHarmless(x, lowercaseOk));
  if (typeof v === "object") return Object.values(v as object).length <= 80 && Object.values(v as object).every((x) => isHarmless(x, lowercaseOk));
  return false;
}

function allEqual(values: unknown[]): boolean {
  const first = JSON.stringify(values[0]);
  return values.every((v) => JSON.stringify(v) === first);
}

// ---- Field classification ---------------------------------------------------

type FieldPlan =
  | { t: "drop" }
  | { t: "literal"; value: unknown }
  | { t: "browser"; ref: string }
  | { t: "expand"; samples: Record<string, unknown>[] }
  | { t: "param"; type: string; default?: unknown; required: boolean };

function generatedFor(values: unknown[]): string {
  const v = String(values[0] ?? "");
  if (/^\d{6,}$/.test(v)) return `{$rand:${Math.min(v.length, 30)}}`;
  return "{$uuid}";
}

function classify(name: string, values: unknown[], ref: string | undefined, persisted: boolean, sampleCount: number): FieldPlan {
  if (ref) return { t: "browser", ref };
  if (GENERATED_KEYS.test(name)) return { t: "literal", value: generatedFor(values) };
  if (CACHE_BUSTERS.test(name)) return { t: "drop" };
  if (OP_LITERAL.test(name) || (name === "query" && persisted)) return { t: "literal", value: values[0] };
  if (name === "variables") {
    const parsed = values.map(parseJsonText);
    if (parsed.every((p) => p && typeof p === "object" && !Array.isArray(p))) return { t: "expand", samples: parsed as Record<string, unknown>[] };
  }
  if (SESSION_KEYS.test(name) || values.some(looksLikeToken)) return { t: "browser", ref: `live:${name}` };

  const parsed = values.map(parseJsonText);
  if (persisted) {
    // In a persisted-query request, everything but the variables is plumbing the page sends.
    if (allEqual(parsed) && isHarmless(parsed[0], true)) return { t: "literal", value: values[0] };
    return { t: "browser", ref: `live:${name}` };
  }
  const constant = allEqual(parsed);
  const canDefault = constant && isHarmless(parsed[0], DEFAULTABLE.test(name));
  const numeric = values.every((v) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)));
  const type = values.every((v) => typeof v === "number") ? jsonType(values.find((v) => !Number.isInteger(v)) ?? values[0]) : numeric ? "number" : jsonType(parsed[0]);
  return {
    t: "param",
    type,
    ...(canDefault ? { default: numeric && typeof parsed[0] === "string" ? Number(parsed[0]) : parsed[0] } : {}),
    required: !canDefault && values.length === sampleCount && type !== "boolean",
  };
}

interface Builder {
  params: Set<string>;
  properties: Record<string, unknown>;
  required: string[];
  browserRefs: Set<string>;
  /** Recorded values per parameter: only used to write hints, never stored. */
  samples: Record<string, unknown[]>;
}

function addParam(b: Builder, base: string, schema: Record<string, unknown>, required: boolean, fallback = "param", samples: unknown[] = []): string {
  const name = uniqueName(base, b.params, fallback);
  b.properties[name] = schema;
  b.samples[name] = samples;
  if (required) b.required.push(name);
  return name;
}

/** Applies a plan, returning the template to put in the query/body, or undefined to leave the field out. */
function templateFor(b: Builder, key: string, plan: FieldPlan, as: "text" | "json", values: unknown[] = []): unknown {
  switch (plan.t) {
    case "drop":
      return undefined;
    case "literal":
      return plan.value;
    case "browser":
      b.browserRefs.add(plan.ref.replace(/^(\w+):/, "$1 "));
      return `{$${plan.ref}}`;
    case "expand": {
      const keys = [...new Set(plan.samples.flatMap((s) => Object.keys(s)))];
      const obj: Record<string, unknown> = {};
      for (const k of keys) {
        const vals = plan.samples.map((s) => s[k]).filter((v) => v !== undefined);
        if (GENERATED_KEYS.test(k)) {
          obj[k] = generatedFor(vals);
          continue;
        }
        // Hidden flags like __relay_internal__pv__…: keep what the page sent.
        if (k.startsWith("__") && allEqual(vals) && isHarmless(vals[0], true)) {
          obj[k] = vals[0];
          continue;
        }
        if (SESSION_KEYS.test(k) || vals.some(looksLikeToken)) {
          b.browserRefs.add(`live ${k}`);
          obj[k] = `{$live:${k}}`;
          continue;
        }
        const harmless = allEqual(vals) && isHarmless(vals[0], DEFAULTABLE.test(k));
        const type = jsonType(vals[0]);
        const shape = type === "object" && vals[0] ? { description: `An object with: ${Object.keys(vals[0] as object).slice(0, 12).join(", ")}` } : {};
        const name = addParam(
          b,
          k,
          { type, ...shape, ...(harmless ? { default: vals[0] } : {}) },
          !harmless && vals.length === plan.samples.length && type !== "boolean" && type !== "object",
          "var",
          vals,
        );
        obj[k] = `{${name}}`;
      }
      return as === "json" ? obj : { json: obj };
    }
    case "param": {
      const name = addParam(b, key, { type: plan.type, ...(plan.default !== undefined ? { default: plan.default } : {}) }, plan.required, "param", values);
      return `{${name}}`;
    }
  }
}

function asText(v: unknown): ValueTemplate {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && "json" in (v as object) && Object.keys(v as object).length === 1) return v as ValueTemplate;
  return v !== null && typeof v === "object" ? { json: v } : String(v);
}

// ---- Persisted operations ---------------------------------------------------

interface Operation {
  name: string;
  /** Path segments are kept as they are (X puts the query id in the path). */
  literalPath: boolean;
  queryText?: string;
}

interface Fields {
  query: Map<string, string[]>;
  body?: Record<string, unknown>;
  bodyKind?: "json" | "form";
  bodyRaw?: unknown;
}

function fieldsOf(r: CapturedRequest, u: URL): Fields {
  const query = new Map<string, string[]>();
  u.searchParams.forEach((v, k) => {
    if (!query.has(k)) query.set(k, []);
    query.get(k)!.push(v);
  });
  if (!r.requestBody || r.method.toUpperCase() === "GET") return { query };
  const ctype = r.requestContentType ?? "";
  try {
    const parsed = JSON.parse(r.requestBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { query, body: parsed, bodyKind: "json" };
    return { query, bodyKind: "json", bodyRaw: parsed };
  } catch {
    // not JSON
  }
  if (/x-www-form-urlencoded/i.test(ctype) || /^[\w%.[\]-]+=[^&]*(&[\w%.[\]-]+=[^&]*)*$/.test(r.requestBody)) {
    const body: Record<string, unknown> = {};
    new URLSearchParams(r.requestBody).forEach((v, k) => (body[k] = v));
    return { query, body, bodyKind: "form" };
  }
  return { query };
}

function operationOf(u: URL, f: Fields): Operation | undefined {
  const get = (k: string): unknown => f.body?.[k] ?? f.query.get(k)?.[0];
  const friendly = get("fb_api_req_friendly_name");
  if (typeof friendly === "string" && friendly) return { name: friendly, literalPath: false };
  const xPath = /\/graphql\/([A-Za-z0-9_-]{8,})\/([A-Za-z][A-Za-z0-9_]*)\/?$/.exec(u.pathname);
  if (xPath) return { name: xPath[2]!, literalPath: true };
  const q = get("query");
  const queryText = typeof q === "string" && /^\s*(query|mutation|subscription|\{|fragment)/.test(q) ? q : undefined;
  const opName = get("operationName");
  if (typeof opName === "string" && opName) return { name: opName, literalPath: false, queryText };
  if (queryText) return { name: /^\s*(?:query|mutation)\s+(\w+)/.exec(queryText)?.[1] ?? "graphql_query", literalPath: false, queryText };
  const docId = get("doc_id") ?? get("query_hash") ?? get("queryId");
  if (typeof docId === "string" && docId) return { name: `query_${docId.slice(-8)}`, literalPath: false };
  return undefined;
}

function opToolBase(op: Operation): string {
  let s = snake(op.name);
  s = s.replace(/^((polaris|comet|barcelona|relay|use|fetch|xdt|api|web|graphql)_)+/, "");
  s = s.replace(/(_(query|mutation|refetch|pagination|direct|content|root|container|wrapper|request))+$/, "");
  return s || snake(op.name) || "operation";
}

function opMutates(op: Operation, method: string): boolean {
  if (/mutation$/i.test(op.name) || /^\s*mutation\b/.test(op.queryText ?? "")) return true;
  if (/query$/i.test(op.name) || /^\s*(query\b|\{)/.test(op.queryText ?? "")) return false;
  if (/^(create|update|delete|remove|add|send|post|like|unlike|follow|unfollow|block|mute|report|edit|set|save|publish|upload|favorite|retweet|bookmark|vote|join|leave|accept|decline|mark)/i.test(op.name)) return true;
  return method !== "GET";
}

// ---- Main -------------------------------------------------------------------

interface Group {
  kind: "fetch" | "navigation";
  method: string;
  host: string;
  segments: (string | null)[]; // null = parameter
  samples: CapturedRequest[];
  op?: Operation;
}

function urlOf(r: CapturedRequest): URL | undefined {
  try {
    const u = new URL(r.url);
    return u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

function isUsefulFetch(r: CapturedRequest, u: URL): boolean {
  const method = r.method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
  if (r.status < 200 || r.status >= 400) return false;
  if (NOISE_HOSTS.test(u.host) || NOISE_PATH.test(u.pathname) || NOISE_PATH_EXTRA.test(u.pathname)) return false;
  if (method === "GET" && CDN_HOSTS.test(u.host)) return false;
  const json = /json|javascript|graphql/i.test(r.responseContentType ?? "") || /json/i.test(r.requestContentType ?? "");
  if (!json && method === "GET") return false; // pages and files, not API calls
  return true;
}

function sameShape(a: Group, b: Group): boolean {
  return a.kind === b.kind && a.method === b.method && a.host === b.host && a.op?.name === b.op?.name && a.segments.length === b.segments.length;
}

export function inferTools(requests: CapturedRequest[]): InferResult {
  const notes: string[] = [];
  const groups: Group[] = [];
  let skipped = 0;

  for (const r of requests) {
    const u = urlOf(r);
    if (!u) continue;
    const kind = r.kind === "navigation" ? "navigation" : "fetch";
    if (kind === "navigation") {
      if (NOISE_HOSTS.test(u.host) || NOISE_PATH.test(u.pathname)) continue;
    } else if (!isUsefulFetch(r, u)) continue;

    const method = kind === "navigation" ? "GET" : r.method.toUpperCase();
    const op = kind === "fetch" ? operationOf(u, fieldsOf(r, u)) : undefined;
    if (SENSITIVE.test(u.pathname) || (op && SENSITIVE.test(op.name))) {
      skipped++;
      continue;
    }
    if (op && NOISE_OP.test(snake(op.name))) {
      skipped++;
      continue;
    }
    const raw = u.pathname.split("/").filter(Boolean);
    // API paths: a username-like last part (e.g. /profile_pic/alice.b) becomes a parameter too.
    const segments = op?.literalPath
      ? raw
      : raw.map((s, i) =>
          isIdSegment(s) || (kind === "navigation" ? isPersonalSlug(s) : i === raw.length - 1 && i > 0 && isPersonalApiSlug(s)) ? null : s,
        );
    const probe: Group = { kind, method, host: u.host, segments, samples: [r], op };
    const g = groups.find((x) => sameShape(x, probe) && x.segments.every((s, i) => s === segments[i]));
    if (g) g.samples.push(r);
    else groups.push(probe);
  }

  // Merge groups that differ in exactly one literal segment (e.g. /users/alice/repos vs /users/bob/repos).
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!;
      const b = groups[j]!;
      if (!sameShape(a, b) || a.op?.literalPath) continue;
      const diff = a.segments.map((s, k) => (s === b.segments[k] ? -1 : k)).filter((k) => k >= 0);
      if (diff.length !== 1) continue;
      const k = diff[0]!;
      const middle = k > 0 && k < a.segments.length - 1;
      const pageSlug = a.kind === "navigation" && !STATIC_PAGES.test(a.segments[k] ?? "") && !STATIC_PAGES.test(b.segments[k] ?? "");
      if (middle || pageSlug) {
        a.segments[k] = null;
        a.samples.push(...b.samples);
        groups.splice(j, 1);
        j--;
      }
    }
  }

  const toolNames = new Set<string>();
  const tools: Tool[] = [];
  const hosts = new Set<string>();
  const built: { tool: Tool; samples: Record<string, unknown[]>; response?: string; trigger?: "action" | "navigate" }[] = [];

  for (const g of groups) {
    hosts.add(g.host);
    const b: Builder = { params: new Set(), properties: {}, required: [], browserRefs: new Set(), samples: {} };

    // Path
    const pathParts: string[] = [];
    g.segments.forEach((seg, i) => {
      if (seg !== null) {
        pathParts.push(seg);
        return;
      }
      const prev = i > 0 ? g.segments[i - 1] : null;
      const base = prev && !VERSION_SEG.test(prev) ? `${singular(snake(prev))}_id` : g.kind === "navigation" ? "name" : "id";
      const values = g.samples.map((s) => new URL(s.url).pathname.split("/").filter(Boolean)[i]);
      const name = addParam(b, base, { type: "string", description: `Value for the "${prev ?? "first"}" part of the URL` }, true, "id", values);
      pathParts.push(`{${name}}`);
    });
    const trailingSlash = g.kind === "navigation" && pathParts.length > 0 && g.samples.some((s) => s.url.split(/[?#]/)[0]!.endsWith("/"));
    const url = `https://${g.host}/${pathParts.join("/")}${trailingSlash ? "/" : ""}`;
    const persisted = Boolean(g.op);

    // Query
    const queryValues = new Map<string, string[]>();
    const refOf = (where: string, key: string) => g.samples.map((s) => s.refs?.[`${where}:${key}`]).find(Boolean);
    for (const s of g.samples) {
      new URL(s.url).searchParams.forEach((v, k) => {
        if (!queryValues.has(k)) queryValues.set(k, []);
        queryValues.get(k)!.push(v);
      });
    }
    const query: Record<string, ValueTemplate> = {};
    for (const [k, values] of queryValues) {
      let plan = classify(k, values, refOf("query", k), persisted, g.samples.length);
      if (g.kind === "navigation" && plan.t === "browser") plan = { t: "drop" }; // page URLs can't carry these
      const t = templateFor(b, k, plan, "text", values);
      if (t !== undefined) query[k] = asText(t);
    }

    // Body
    let body: HttpAction["body"];
    if (g.kind === "fetch" && g.method !== "GET") {
      const fs = g.samples.map((s) => fieldsOf(s, new URL(s.url)));
      const withBody = fs.filter((f) => f.body);
      if (withBody.length) {
        const kind = withBody[0]!.bodyKind!;
        const keys = [...new Set(withBody.flatMap((f) => Object.keys(f.body!)))];
        const value: Record<string, unknown> = {};
        for (const k of keys) {
          const values = withBody.map((f) => f.body![k]).filter((v) => v !== undefined);
          const plan = classify(k, values, refOf("body", k), persisted, withBody.length);
          const t = templateFor(b, k, plan, kind === "json" ? "json" : "text", values);
          if (t !== undefined) value[k] = kind === "json" ? t : asText(t);
        }
        body = { encoding: kind, value };
      } else {
        const raw = fs.find((f) => f.bodyRaw !== undefined);
        if (raw) {
          const name = addParam(b, "body", { type: jsonType(raw.bodyRaw), description: "Request body" }, true, "body");
          body = { encoding: "json", value: `{${name}}` };
        }
      }
    }

    // Headers
    const headers: Record<string, string> = {};
    if (g.kind === "fetch") {
      const seen = new Map<string, CapturedHeader[]>();
      for (const s of g.samples) {
        for (const h of s.headers ?? []) {
          const n = h.name.toLowerCase();
          if (SKIP_HEADERS.test(n)) continue;
          if (!seen.has(n)) seen.set(n, []);
          seen.get(n)!.push(h);
        }
      }
      for (const [n, hs] of seen) {
        if (g.op && /friendly-name|operation-?name/i.test(n)) {
          headers[n] = g.op.name; // names this request's own operation, not the page's latest one
          continue;
        }
        const ref = hs.find((h) => h.ref && h.ref !== "live")?.ref;
        const first = hs[0]!.value;
        // The recorder only keeps values it judged harmless; still never keep obvious secrets.
        const secretName = /auth|token|csrf|xsrf|session|secret|key|sig|claim|lsd|dtsg|cookie|nonce/i.test(n);
        const literal = first !== undefined && hs.every((h) => h.value === first) && !secretName && !looksLikeToken(first) ? first : undefined;
        if (ref) {
          headers[n] = `{$${ref}}`;
          b.browserRefs.add(ref.replace(":", " "));
        } else if (literal !== undefined) {
          headers[n] = literal;
        } else {
          headers[n] = `{$live:${n}}`;
          b.browserRefs.add(`live ${n}`);
        }
      }
    }

    // Name and description
    const literal = g.segments.filter((s): s is string => s !== null && !VERSION_SEG.test(s)).map((s) => snake(s)).filter(Boolean);
    const last = literal[literal.length - 1] ?? snake(g.host.replace(/^www\./, "").split(".")[0] ?? "api");
    const endsWithParam = g.segments[g.segments.length - 1] === null;
    let base: string;
    if (g.kind === "navigation") base = literal.length ? `open_${literal.slice(-2).join("_")}` : endsWithParam ? "open_page" : "open_home";
    else if (g.op) base = opToolBase(g.op);
    else if (VERB_SEGS.test(last)) base = literal.length > 1 ? `${last}_${literal[literal.length - 2]}` : last;
    else if (g.method === "GET") base = endsWithParam ? `get_${singular(last)}` : queryValues.has("q") || queryValues.has("query") ? `search_${last}` : `get_${last}`;
    else if (g.method === "POST") base = `create_${singular(last)}`;
    else if (g.method === "DELETE") base = `delete_${singular(last)}`;
    else base = `update_${singular(last)}`;
    const name = uniqueName(base, toolNames);

    const inputs = Object.keys(b.properties);
    const site = g.host.replace(/^www\./, "");
    const input: InputSchema = { type: "object", properties: b.properties, ...(b.required.length ? { required: b.required } : {}) };
    const inputsNote = inputs.length ? ` Inputs: ${inputs.join(", ")}.` : "";

    if (g.kind === "navigation") {
      const action: PageAction = { kind: "page", url, ...(Object.keys(query).length ? { query } : {}), maxChars: 20_000 };
      tools.push({
        name,
        title: titleFromName(name),
        description: `Opens ${url} on ${site} and returns the page text.${inputsNote} Recorded from your visit; edit this description.`,
        input,
        mutates: false,
        action,
      });
      built.push({ tool: tools[tools.length - 1]!, samples: b.samples });
      continue;
    }

    const pick = guessPick(g.samples.find((s) => s.responseSample)?.responseSample);
    const mutates = g.op ? opMutates(g.op, g.method) : g.method !== "GET";
    const what = g.op ? `${g.op.name} (GraphQL) on ${site}` : `${g.method} ${url}`;
    tools.push({
      name,
      title: titleFromName(name),
      description: `${what}.${inputsNote} Recorded from the site; edit this description.`,
      input,
      mutates,
      action: {
        kind: "http",
        method: g.method as HttpAction["method"],
        url,
        ...(Object.keys(query).length ? { query } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(body ? { body } : {}),
        response: { ...(pick ? { pick } : {}), maxChars: 20_000 },
      },
    });
    const trigger = g.samples.some((s) => s.trigger === "action") ? "action" : g.samples.some((s) => s.trigger === "navigate") ? "navigate" : undefined;
    built.push({ tool: tools[tools.length - 1]!, samples: b.samples, response: g.samples.map((s) => s.responseSample ?? "").join("\n"), trigger });
    if (b.browserRefs.size) {
      // Recognizable names first; "__xyz" plumbing last.
      const names = [...b.browserRefs].map((r) => r.split(" ")[1]!).sort((x, y) => Number(x.startsWith("__")) - Number(y.startsWith("__")));
      const list = names.slice(0, 6).join(", ");
      notes.push(`${name}: ${b.browserRefs.size} login/session value(s) (${list}${b.browserRefs.size > 6 ? ", …" : ""}) are filled in by your browser each time it runs, never saved.`);
    }
  }

  addSourceHints(built);
  if (skipped) notes.push(`Skipped ${skipped} background call(s) the page makes on its own (ads, logging, promotions, presence).`);
  const details: InferResult["details"] = {};
  for (const x of built) {
    const examples: Record<string, unknown> = {};
    for (const [param, values] of Object.entries(x.samples)) {
      const v = values[values.length - 1];
      if (isIdLike(v)) examples[param] = v;
    }
    details[x.tool.name] = { examples, ...(x.trigger ? { trigger: x.trigger } : {}) };
  }
  return { tools, allowedHosts: [...hosts], notes, details };
}

/** Numbers and opaque ids, never words or sentences someone typed. */
function isIdLike(v: unknown): boolean {
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) >= 1000;
  if (typeof v !== "string") return false;
  return /^\d{4,40}$/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || (/^[A-Za-z0-9_-]{8,64}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/[aeiou]{2}[a-z]{3}/i.test(v));
}

/** Tells the AI where an id comes from: a page address, or another tool's result. */
function addSourceHints(built: { tool: Tool; samples: Record<string, unknown[]>; response?: string }[]): void {
  for (const target of built) {
    for (const [param, values] of Object.entries(target.samples)) {
      const vals = values.map((v) => (typeof v === "number" ? String(v) : v)).filter((v): v is string => typeof v === "string" && v.length >= 4 && !/^(true|false)$/.test(v));
      if (!vals.length) continue;
      const prop = target.tool.input.properties[param] as Record<string, unknown> | undefined;
      if (!prop) continue;
      let hint: string | undefined;
      for (const other of built) {
        if (other === target) continue;
        if (other.tool.action.kind === "page") {
          const p = Object.entries(other.samples).find(([, ov]) => ov.some((x) => vals.includes(String(x))));
          if (p) {
            hint = `Same value as {${p[0]}} in the page address ${other.tool.action.url} (e.g. from a link or the address bar).`;
            break;
          }
        } else if (other.response && vals.some((v) => other.response!.includes(`"${v}"`) || other.response!.includes(`:${v},`) || other.response!.includes(`:${v}}`))) {
          hint = `Comes from the result of ${other.tool.name}.`;
          break;
        }
      }
      if (hint) prop.description = prop.description ? `${prop.description}. ${hint}` : hint;
    }
  }
}

/**
 * Identifies the action a tool performs, ignoring ids sites change on every release (Facebook
 * doc_id, X query id in the path). Two tools with the same key do the same thing.
 */
export function operationKey(tool: Tool): string {
  const a = tool.action;
  if (a.kind !== "http") return toolSignature(tool);
  const v = (a.body?.value ?? {}) as Record<string, unknown>;
  const q = (a.query ?? {}) as Record<string, unknown>;
  let url = a.url;
  let op = [v.fb_api_req_friendly_name, v.operationName, q.operationName].find((x) => typeof x === "string" && x) as string | undefined;
  const x = /^(https:\/\/[^/]+.*\/graphql\/)[A-Za-z0-9_-]{8,}\/([A-Za-z][A-Za-z0-9_]*)\/?$/.exec(a.url);
  if (x) {
    url = `${x[1]}*`;
    op ??= x[2];
  }
  if (!op) return toolSignature(tool);
  return `op ${a.method} ${new URL(url.replace(/\{[^}]+\}/g, "x").replace("*", "x")).host} ${op}`;
}

/** Identifies what a tool calls, to spot tools that already exist. */
export function toolSignature(tool: Tool): string {
  const a = tool.action;
  if (a.kind === "http") {
    const v = (a.body?.value ?? {}) as Record<string, unknown>;
    const q = (a.query ?? {}) as Record<string, unknown>;
    const op = [v.fb_api_req_friendly_name, v.doc_id, v.operationName, q.operationName, q.doc_id, q.queryId].find((x) => typeof x === "string");
    return `http ${a.method} ${a.url}${op ? ` ${op}` : ""}`;
  }
  if (a.kind === "page") return `page ${a.url}`;
  if (a.kind === "form") return `form ${a.page} ${a.form}`;
  if (a.kind === "mcp") return `mcp ${a.server} ${a.tool}`;
  return `webmcp ${a.page} ${a.tool}`;
}

const ID_LITERALS = /^(doc_id|docid|query_id|queryid|query_hash|extensions|persistedquery)$/i;

/**
 * Updates an existing tool from a freshly learned copy of the same action (same operationKey):
 * refreshes ids the site changed (doc_id, X query id), adds inputs the fresh request has and the
 * tool lacks, or, with `replace`, takes the fresh request shape entirely (for a tool that stopped
 * working). Keeps the tool's name, title and description. Returns what changed, empty if nothing.
 */
export function patchTool(existing: Tool, fresh: Tool, replace = false): { tool: Tool; changes: string[] } {
  const changes: string[] = [];
  const tool: Tool = structuredClone(existing);
  if (existing.action.kind !== "http" || fresh.action.kind !== "http") return { tool, changes };
  const ea = tool.action as HttpAction;
  const fa = fresh.action;

  if (replace) {
    const before = JSON.stringify(ea);
    tool.action = structuredClone(fa);
    const props = structuredClone(fresh.input.properties) as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(existing.input.properties)) {
      const old = v as Record<string, unknown>;
      if (props[k] && old.description) props[k]!.description = old.description;
    }
    tool.input = { ...fresh.input, properties: props };
    if (JSON.stringify(tool.action) !== before) changes.push("rebuilt from the site's current request");
    return { tool, changes };
  }

  if (ea.url !== fa.url && /\/graphql\/[A-Za-z0-9_-]{8,}\//.test(fa.url)) {
    ea.url = fa.url;
    changes.push("new query id");
  }
  const patchLiterals = (target: Record<string, unknown> | undefined, source: Record<string, unknown> | undefined) => {
    if (!target || !source) return;
    for (const [k, v] of Object.entries(source)) {
      if (ID_LITERALS.test(k) && typeof v === "string" && target[k] !== v) {
        target[k] = v;
        if (!changes.includes("new query id")) changes.push("new query id");
      }
    }
  };
  patchLiterals(ea.query as Record<string, unknown> | undefined, fa.query as Record<string, unknown> | undefined);
  patchLiterals(ea.body?.value as Record<string, unknown> | undefined, fa.body?.value as Record<string, unknown> | undefined);

  // New inputs: keys the fresh request sends (top level or inside variables) that the tool doesn't.
  const added: string[] = [];
  const addKeys = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(source)) {
      if (k in target) continue;
      target[k] = v;
      for (const m of JSON.stringify(v).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const param = m[1]!;
        if (!(param in tool.input.properties) && param in fresh.input.properties) {
          tool.input.properties[param] = structuredClone(fresh.input.properties[param]);
          added.push(param);
        }
      }
    }
  };
  const varsOf = (a: HttpAction): Record<string, unknown> | undefined => {
    const v = (a.body?.value as Record<string, unknown> | undefined)?.variables ?? (a.query as Record<string, unknown> | undefined)?.variables;
    if (v && typeof v === "object") return ("json" in (v as object) ? (v as { json: unknown }).json : v) as Record<string, unknown>;
    return undefined;
  };
  const ev = varsOf(ea);
  const fv = varsOf(fa);
  if (ev && fv) addKeys(ev, fv);
  if (added.length) changes.push(`new input(s): ${added.join(", ")}`);
  return { tool, changes };
}
