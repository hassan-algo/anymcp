// Makes another MCP server's results smaller before the AI sees them, without losing information:
// drops empty/null fields, minifies JSON, and caps very long arrays and the total size.

export const DEFAULT_MCP_MAX_CHARS = 25_000;
const MAX_ARRAY = 100;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
}

/** Removes null/empty values and caps arrays. Keeps false and 0. */
export function compactJson(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => compactJson(v, depth + 1)).filter((v) => !isEmpty(v));
    if (items.length > MAX_ARRAY) return [...items.slice(0, MAX_ARRAY), `… ${items.length - MAX_ARRAY} more item(s)`];
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compactJson(v, depth + 1);
      if (!isEmpty(c)) out[k] = c;
    }
    return out;
  }
  return value;
}

/** Compacts one text block: JSON gets the treatment above, other text is left alone. */
export function compactText(text: string): string {
  const t = text.trim();
  if (/^[[{]/.test(t)) {
    try {
      return JSON.stringify(compactJson(JSON.parse(t)));
    } catch {
      // not JSON after all
    }
  }
  return text;
}

type Content = { type: string; text?: string; [k: string]: unknown };

/**
 * Compacts a tool result's content. Text is compacted and the total is capped at `maxChars`;
 * images and other blocks pass through. Returns the sizes before and after (text only).
 */
export function compactContent(content: Content[], maxChars = DEFAULT_MCP_MAX_CHARS): { content: Content[]; rawChars: number; returnedChars: number } {
  let raw = 0;
  let budget = maxChars;
  const out: Content[] = [];
  for (const c of content) {
    if (c.type !== "text" || typeof c.text !== "string") {
      out.push(c);
      continue;
    }
    raw += c.text.length;
    let t = compactText(c.text);
    if (budget <= 0) continue;
    if (t.length > budget) t = `${t.slice(0, budget)}\n\n[truncated: ${t.length - budget} more characters]`;
    budget -= t.length;
    out.push({ type: "text", text: t });
  }
  const returned = out.reduce((n, c) => n + (c.type === "text" && typeof c.text === "string" ? c.text.length : 0), 0);
  return { content: out, rawChars: raw, returnedChars: returned };
}
