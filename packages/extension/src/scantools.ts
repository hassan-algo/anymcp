// Turns a page scan (forms, WebMCP tools, OpenAPI, official profile) into tools.
// Used by the background (scan_tab, for the AI) and the setup window.

import { hostOfTemplate, snake, toolFromForm, toolsFromOpenApi, uniqueName, validateProfile, type Profile, type Tool } from "@anymcp/shared";
import type { ScanResult } from "./messages.js";

export interface ScanTool {
  tool: Tool;
  source: "form" | "webmcp" | "openapi";
}

export interface ScanTools {
  items: ScanTool[];
  allowedHosts: string[];
  notes: string[];
  /** e.g. "2 forms", "1 WebMCP tool". */
  found: string[];
  /** The site's own /.well-known/anymcp.json, when valid. */
  official?: Profile;
  /** The raw /.well-known/anymcp.json, valid or not. */
  officialRaw?: unknown;
  /** From the OpenAPI document, if any. */
  apiTitle?: string;
  apiDescription?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function webmcpTool(w: ScanResult["webmcp"][number], page: string, taken: Set<string>): Tool {
  const schema = w.inputSchema as { type?: string; properties?: unknown } | undefined;
  const input =
    schema && schema.type === "object"
      ? { ...(schema as object), type: "object" as const, properties: (schema.properties as Record<string, unknown>) ?? {} }
      : { type: "object" as const, properties: {} };
  const readOnly = (w.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true;
  return {
    name: uniqueName(snake(w.name), taken),
    title: w.name,
    description: w.description.length >= 10 ? w.description.slice(0, 500) : `Runs the page's own "${w.name}" tool.`,
    input,
    mutates: !readOnly,
    action: { kind: "webmcp", page, tool: w.name },
  };
}

/** `taken`: tool names already in use (new names avoid them). */
export function toolsFromScan(r: ScanResult, taken = new Set<string>()): ScanTools {
  const u = new URL(r.url);
  const page = `${u.origin}${u.pathname}`;
  const out: ScanTools = { items: [], allowedHosts: [], notes: [], found: [] };

  const forms = r.forms.map((f) => toolFromForm(f, taken)).filter((t): t is Tool => Boolean(t));
  out.items.push(...forms.map((tool) => ({ tool, source: "form" as const })));
  if (forms.length) out.found.push(plural(forms.length, "form"));
  if (r.skippedLoginForms) out.notes.push(`Skipped ${plural(r.skippedLoginForms, "login form")}. AnyMCP never fills in passwords.`);

  if (r.webmcp.length) {
    out.items.push(...r.webmcp.map((w) => ({ tool: webmcpTool(w, page, taken), source: "webmcp" as const })));
    out.found.push(plural(r.webmcp.length, "WebMCP tool"));
  }

  if (r.openapi) {
    const api = toolsFromOpenApi(r.openapi.doc, r.openapi.url);
    for (const tool of api.tools) {
      tool.name = taken.has(tool.name) ? uniqueName(tool.name, taken) : (taken.add(tool.name), tool.name);
      out.items.push({ tool, source: "openapi" });
    }
    out.notes.push(...api.notes);
    if (api.tools.length) out.found.push(`${plural(api.tools.length, "API operation")} from ${new URL(r.openapi.url).pathname}`);
    out.apiTitle = api.title;
    out.apiDescription = api.description;
  }

  if (r.official !== undefined) {
    out.officialRaw = r.official;
    const v = validateProfile(r.official);
    if (v.ok) out.official = v.profile;
    else out.notes.push(`The site has /.well-known/anymcp.json, but it isn't a valid profile (${v.errors[0]}).`);
  }

  const hosts = new Set<string>();
  for (const { tool: t } of out.items) {
    const host = hostOfTemplate(t.action.kind === "http" || t.action.kind === "page" ? t.action.url : "page" in t.action ? t.action.page : "");
    if (host) hosts.add(host);
  }
  out.allowedHosts = [...hosts];
  return out;
}
