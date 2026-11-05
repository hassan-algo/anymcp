// Scans a profile for personal data or secrets before it's published.

export interface PrivacyFinding {
  /** "block": must be fixed before publishing. "warn": check it. */
  severity: "block" | "warn";
  path: string;
  message: string;
  value: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const LONG_HEX = /\b[0-9a-f]{24,}\b/i;
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/;
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{8,}\d(?![\w.])/;
const SECRET_HEADER = /^(authorization|cookie|x-csrf-token|x-xsrf-token|x-api-key|api-key|x-auth-token)$/i;
const TEMPLATE_ONLY = /^(\{[^}]+\}|\s)*$/;

function mask(v: string): string {
  return v.length <= 12 ? v : `${v.slice(0, 6)}…${v.slice(-4)}`;
}

function walk(value: unknown, path: string, visit: (path: string, v: string, key?: string) => void, key?: string): void {
  if (typeof value === "string") visit(path, value, key);
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit, k);
  }
}

export function scanForPersonalData(profile: unknown): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const add = (severity: PrivacyFinding["severity"], path: string, message: string, value: string) =>
    findings.push({ severity, path, message, value: mask(value) });

  walk(profile, "", (path, v, key) => {
    const inHeaders = /\.headers\.[^.]+$/.test(path);
    // Descriptions are prose written by the author; only look for the obvious there.
    const prose = /\.(description|title|name)$/.test(path) || path === "description" || path === "name";
    const stripped = v.replace(/\{[^}]+\}/g, "");

    if (inHeaders && key && SECRET_HEADER.test(key) && !TEMPLATE_ONLY.test(v.replace(/\{\$[^}]+\}/g, ""))) {
      add("block", path, `The "${key}" header has a fixed value. Use a {$cookie:…}, {$meta:…} or {$live:…} placeholder instead.`, v);
      return;
    }
    if (JWT.test(stripped)) return add("block", path, "Looks like a login token (JWT).", v);
    if (BEARER.test(stripped)) return add("block", path, "Looks like an authorization credential.", v);
    if (path.startsWith("authors")) return;
    if (EMAIL.test(stripped) && !/example\.(com|org)/i.test(stripped)) return add("warn", path, "Contains an email address.", v);
    if (prose) return;
    // Public ids of a site's saved queries (doc_id, Apollo sha256Hash…) look random but aren't secrets.
    if (key && /^(doc_id|docid|query_id|queryid|query_hash|extensions|sha256hash|persistedquery)$/i.test(key)) return;
    if (UUID.test(stripped)) return add("warn", path, "Contains an ID that may belong to your account. Make it a parameter.", v);
    if (LONG_HEX.test(stripped) || (LONG_TOKEN.test(stripped) && /\d/.test(stripped) && /[a-z]/.test(stripped) && /[A-Z]/.test(stripped))) {
      return add("block", path, "Contains a long token-like value.", v);
    }
    if (PHONE.test(stripped) && !/^https?:/.test(stripped)) return add("warn", path, "Contains something that looks like a phone number.", v);
  });
  return findings;
}
