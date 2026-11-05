// Turns a raw HTTP response into compact text for the AI, following a profile's `response` rules.

import type { ResponseShape } from "./profile.js";

export const DEFAULT_MAX_CHARS = 20_000;

export function getPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  let cur = target;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = value;
    else cur = (cur[p] ??= {}) as Record<string, unknown>;
  });
}

function pickFields(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => pickFields(v, fields));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = getPath(value, f);
    if (v !== undefined) setPath(out, f, v);
  }
  return out;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} more characters]`;
}

/** Very rough HTML to text, for responses that aren't JSON. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function shapeResponse(body: string, contentType: string, shape: ResponseShape | undefined): string {
  const maxChars = shape?.maxChars ?? DEFAULT_MAX_CHARS;
  // Some sites prefix JSON with junk to stop it being loaded as a script.
  body = body.replace(/^\s*(for\s*\(;;\);|while\s*\(1\);|\)\]\}'\s*,?)/, "");
  const looksJson = /json/i.test(contentType) || /^\s*[[{]/.test(body);
  if (looksJson) {
    try {
      let value: unknown = JSON.parse(body);
      if (shape?.pick) value = getPath(value, shape.pick);
      if (shape?.fields?.length) value = pickFields(value, shape.fields);
      return truncate(JSON.stringify(value ?? null), maxChars);
    } catch {
      // Not JSON after all.
    }
  }
  if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body)) return truncate(htmlToText(body), maxChars);
  return truncate(body, maxChars);
}
