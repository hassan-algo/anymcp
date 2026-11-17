// Making big responses fit the AI's budget without losing the useful part.
//
// slimJson: drops what's rarely useful to the AI: empty values, lists of image/video size
//   variants (url + width/height), streaming manifests, and very long CDN addresses.
// fitJson:  cuts the main list by whole items (never mid-item) and says how many were left out.
// parseFeed: Atom/RSS (e.g. Gmail's unread feed, arXiv) to compact entries.

import { compactJson } from "./compact.js";

/** Keys whose values are media plumbing, not content. */
const HEAVY_KEYS =
  /^(image_versions\d*|video_versions|video_dash_manifest|dash_manifest|hls_manifest|candidates|display_resources|thumbnail_resources|scrubber_spritesheet_info_list|spritesheet_info|sprite_urls|video_codec|video_subtitles_uri|audio_reattribution_info|original_sound_info|music_metadata|clips_metadata|sharing_friction_info|fb_user_tags|media_overlay_info|creative_config|thumbnails|srcset|blurhash)$/i;
const CDN_URL = /^https?:\/\/[^/\s]*(fbcdn\.net|cdninstagram\.com|twimg\.com|ytimg\.com|googleusercontent\.com|licdn\.com|pinimg\.com|cloudfront\.net|akamaized\.net|redditmedia\.com|scontent)[^\s]*$/i;

/** An array of image/video size variants: objects with a url and a width or height. */
function isVariantList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => x && typeof x === "object" && !Array.isArray(x) && ("url" in x || "src" in x) && ("width" in x || "height" in x))
  );
}

const TIME_KEY = /(^|_)(at|time|timestamp|date|created|published|updated)$/i;
const PINNED_KEY = /pinned/i;

/** Unix seconds or milliseconds in a plausible range, as an ISO date. */
function asDate(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  const ms = v > 1e12 ? v : v * 1000;
  return ms > Date.UTC(2005, 0) && ms < Date.UTC(2100, 0) ? new Date(ms).toISOString() : undefined;
}

export function slimJson(value: unknown): unknown {
  // GraphQL replies: "extensions" is server metadata (e.g. video prefetch data), not the answer.
  if (value && typeof value === "object" && !Array.isArray(value) && "data" in value && "extensions" in value) {
    const { extensions: _drop, ...rest } = value as Record<string, unknown>;
    value = rest;
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (HEAVY_KEYS.test(k) || isVariantList(x)) continue;
        // e.g. Instagram's timeline_pinned_user_ids: a non-empty list means the post is pinned.
        if (PINNED_KEY.test(k) && Array.isArray(x)) {
          if (x.length) out.pinned = true;
          continue;
        }
        const date = TIME_KEY.test(k) ? asDate(x) : undefined;
        out[k] = date ?? walk(x);
      }
      // Instagram media: the shortcode is the post's address.
      const o = v as Record<string, unknown>;
      if (typeof o.code === "string" && "media_type" in o && "taken_at" in o && !("url" in o))
        out.url = `https://www.instagram.com/p/${o.code}/`;
      return out;
    }
    if (typeof v === "string") {
      if (v.length > 120 && CDN_URL.test(v)) return "[media url]";
      if (v.length > 4000) return `${v.slice(0, 4000)}… [${v.length - 4000} more characters]`;
    }
    return v;
  };
  return compactJson(walk(value), 0, Infinity); // fitJson does the cutting, and says so
}

/** Path to the largest array of objects in a value (by serialized size). */
function largestList(value: unknown): { path: (string | number)[]; size: number } | undefined {
  let best: { path: (string | number)[]; size: number } | undefined;
  const visit = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) {
      if (v.length > 1 && v.some((x) => x && typeof x === "object")) {
        const size = JSON.stringify(v).length;
        if (!best || size > best.size) best = { path, size };
      }
      v.forEach((x, i) => visit(x, [...path, i]));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, [...path, k]);
    }
  };
  visit(value, []);
  return best;
}

function withList(value: unknown, path: (string | number)[], list: unknown[]): unknown {
  if (!path.length) return list;
  const [head, ...rest] = path;
  if (Array.isArray(value)) return value.map((x, i) => (i === head ? withList(x, rest, list) : x));
  const obj = value as Record<string, unknown>;
  return { ...obj, [head as string]: withList(obj[head as string], rest, list) };
}

function getAt(value: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k as string], value);
}

/** Keys that are plumbing on social and app APIs: ids, tokens, flags, sizes, picture links. */
const NOISE_KEYS =
  /(^__typename$|token|tracking|_url$|url_info|label_info|friendship|^pk$|^id$|_ids?$|^fbid|width$|height$|qualities|eligible|^can_|^is_(?!pinned|paid|verified|private)|^has_(?!liked)|cropping|dimensions|fitting|_style$|audio|^original_(?!sound)|thumbnail|preview|sharing|ig_media|like_and_view|insights|photo_of_you|caption_is_edited|integrity|commerce|sponsor|logging|inventory|^position$|^lat$|^lng$|transparency|_enabled$|_disabled$)/i;

/**
 * One list item reduced to what a person would read: text, counts, dates, names, types.
 * Lists inside it (e.g. a post's carousel or tagged users) keep 3 short entries.
 */
export function summarizeItem(v: unknown, depth = 0, nested = false): unknown {
  if (Array.isArray(v)) {
    const items = v.slice(0, 3).map((x) => summarizeItem(x, depth + 1, true)).filter((x) => x !== undefined);
    return v.length > 3 ? [...items, `… ${v.length - 3} more`] : items;
  }
  if (v && typeof v === "object") {
    if (depth > 5) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (NOISE_KEYS.test(k)) continue;
      const s = summarizeItem(x, depth + 1, nested);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  const max = nested ? 200 : 1500;
  if (typeof v === "string" && v.length > max) return `${v.slice(0, max)}…`;
  return v;
}

/**
 * The fitted text, plus how many items of the main list it shows (undefined when nothing was cut).
 */
export function fitJsonDetailed(value: unknown, maxChars: number): { text: string; shown?: number; total?: number } {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxChars) return { text };
  const list = largestList(value);
  const total = list ? (getAt(value, list.path) as unknown[]).length : undefined;
  const out = fitJson(value, maxChars);
  const shown = /"_anymcp":"showing (\d+) of/.exec(out)?.[1];
  return { text: out, ...(total !== undefined ? { total, shown: shown ? Number(shown) : 0 } : {}) };
}

/**
 * Slim, then fit; if that still leaves fewer than 8 items (or all of them, when there are fewer),
 * reduce each item of the main list to its readable fields and fit again.
 */
export function fitResponse(value: unknown, maxChars: number): string {
  const slim = slimJson(value);
  const first = fitJsonDetailed(slim, maxChars);
  if (first.shown === undefined || first.total === undefined || first.shown >= Math.min(8, first.total)) return first.text;
  const list = largestList(slim)!;
  const items = getAt(slim, list.path) as unknown[];
  const reduced = compactJson(withList(slim, list.path, items.map((x) => summarizeItem(x))), 0, Infinity);
  return fitJsonDetailed(reduced, maxChars).text;
}

/**
 * JSON text no longer than maxChars. If it's too long, the biggest list keeps as many whole
 * items as fit, followed by a note; nested lists are cut the same way, one level at a time.
 */
export function fitJson(value: unknown, maxChars: number, depth = 0): string {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxChars) return text;
  const list = depth < 4 ? largestList(value) : undefined;
  if (list) {
    const items = getAt(value, list.path) as unknown[];
    const note = (shown: number) => ({ _anymcp: `showing ${shown} of ${items.length} items; the rest didn't fit` });
    // Largest number of whole items that fits (binary search).
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (JSON.stringify(withList(value, list.path, [...items.slice(0, mid), note(mid)])).length <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0) return JSON.stringify(withList(value, list.path, [...items.slice(0, lo), note(lo)]));
    // Not even one item fits: cut inside the first item, the same way.
    const one = fitJson(items[0], Math.max(500, maxChars - 200), depth + 1);
    const out = JSON.stringify(withList(value, list.path, [JSON.parse(one), note(1)]));
    if (out.length <= maxChars) return out;
  }
  return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} more characters]`;
}

// ---- Atom / RSS ----

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decode(m[1]!) : undefined;
}

export function looksLikeFeed(body: string, contentType = ""): boolean {
  return /atom|rss/i.test(contentType) || /^\s*(<\?xml[^>]*>\s*)?<(feed|rss)[\s>]/i.test(body);
}

/** Atom or RSS to { title, count?, entries: [{ title, from, email, summary, date, link }] }. */
export function parseFeed(xml: string): Record<string, unknown> {
  const blocks = xml.match(/<(entry|item)[\s>][\s\S]*?<\/(entry|item)>/gi) ?? [];
  const head = xml.split(/<(entry|item)[\s>]/i)[0] ?? "";
  const entries = blocks.map((b) => {
    const author = /<author[\s>]([\s\S]*?)<\/author>/i.exec(b)?.[1] ?? "";
    const link = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? tag(b, "link");
    return compactJson({
      title: tag(b, "title"),
      from: tag(author, "name") ?? (author ? decode(author) : tag(b, "dc:creator")),
      email: tag(author, "email"),
      summary: tag(b, "summary") ?? tag(b, "description"),
      date: tag(b, "issued") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "pubDate"),
      link,
    });
  });
  const count = tag(head, "fullcount");
  return compactJson({ title: tag(head, "title"), ...(count ? { count: Number(count) } : {}), entries }) as Record<string, unknown>;
}
