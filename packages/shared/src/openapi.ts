// Converts an OpenAPI 3 (or Swagger 2) document into draft tools.

import { snake, uniqueName } from "./infer.js";
import type { HttpAction, InputSchema, Tool } from "./profile.js";

type Json = Record<string, any>;

export interface OpenApiResult {
  title?: string;
  description?: string;
  tools: Tool[];
  allowedHosts: string[];
  notes: string[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function resolveRef(doc: Json, value: any, depth = 0): any {
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    const target = value.$ref
      .slice(2)
      .split("/")
      .reduce((acc: any, k: string) => (acc ? acc[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), doc);
    return resolveRef(doc, target, depth + 1);
  }
  return value;
}

/** Keeps a JSON Schema small enough to send to the AI. */
function simplifySchema(doc: Json, schema: any, depth = 0): Json {
  const s = resolveRef(doc, schema) ?? {};
  const out: Json = {};
  if (s.type) out.type = s.type;
  if (s.description) out.description = String(s.description).slice(0, 300);
  if (s.enum) out.enum = s.enum;
  if (s.default !== undefined) out.default = s.default;
  if (s.format) out.format = s.format;
  if (depth < 2 && s.items) out.items = simplifySchema(doc, s.items, depth + 1);
  if (depth < 2 && s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, simplifySchema(doc, v, depth + 1)]));
  }
  if (!out.type) out.type = s.properties ? "object" : "string";
  return out;
}

function baseUrl(doc: Json, specUrl: string): string | undefined {
  try {
    if (doc.swagger === "2.0") {
      const scheme = (doc.schemes ?? ["https"]).includes("https") ? "https" : doc.schemes?.[0];
      const host = doc.host ?? new URL(specUrl).host;
      return new URL(`${scheme}://${host}${doc.basePath ?? ""}`).toString().replace(/\/$/, "");
    }
    const server = doc.servers?.[0]?.url ?? "/";
    const withVars = String(server).replace(/\{([^}]+)\}/g, (_m, v) => doc.servers?.[0]?.variables?.[v]?.default ?? "");
    return new URL(withVars, specUrl).toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function toolsFromOpenApi(doc: Json, specUrl: string): OpenApiResult {
  const notes: string[] = [];
  const base = baseUrl(doc, specUrl);
  if (!base || !base.startsWith("https://")) {
    return { tools: [], allowedHosts: [], notes: ["The API's server URL isn't HTTPS, so no tools were made."] };
  }
  const host = new URL(base).host;
  const names = new Set<string>();
  const tools: Tool[] = [];

  for (const [path, item] of Object.entries<Json>(doc.paths ?? {})) {
    const shared = (item.parameters ?? []) as any[];
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op || op.deprecated) continue;

      const params = new Set<string>();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const query: Record<string, string> = {};
      const headers: Record<string, string> = {};
      let urlPath = path;

      for (const raw of [...shared, ...(op.parameters ?? [])]) {
        const p = resolveRef(doc, raw);
        if (!p?.name || !p.in) continue;
        if (p.in === "cookie" || (p.in === "header" && /^(authorization|cookie)$/i.test(p.name))) continue;
        if (p.in === "body") continue; // Swagger 2 body, handled below
        const name = uniqueName(p.name, params, "param");
        properties[name] = { ...simplifySchema(doc, p.schema ?? { type: p.type ?? "string" }), ...(p.description ? { description: String(p.description).slice(0, 300) } : {}) };
        if (p.required || p.in === "path") required.push(name);
        if (p.in === "path") urlPath = urlPath.replace(`{${p.name}}`, `{${name}}`);
        else if (p.in === "query") query[p.name] = `{${name}}`;
        else if (p.in === "header") headers[p.name] = `{${name}}`;
      }

      let body: HttpAction["body"];
      const swaggerBody = [...shared, ...(op.parameters ?? [])].map((x) => resolveRef(doc, x)).find((x) => x?.in === "body");
      const bodySchema = swaggerBody?.schema ?? resolveRef(doc, op.requestBody)?.content?.["application/json"]?.schema;
      if (bodySchema) {
        const s = resolveRef(doc, bodySchema);
        if (s?.properties) {
          const value: Record<string, string> = {};
          for (const [k, v] of Object.entries(s.properties)) {
            const name = uniqueName(k, params, "field");
            properties[name] = simplifySchema(doc, v);
            if ((s.required ?? []).includes(k)) required.push(name);
            value[k] = `{${name}}`;
          }
          body = { encoding: "json", value };
        } else {
          const name = uniqueName("body", params, "body");
          properties[name] = simplifySchema(doc, s);
          required.push(name);
          body = { encoding: "json", value: `{${name}}` };
        }
      }

      if (/\{[^}]*[^A-Za-z0-9_}][^}]*\}/.test(urlPath)) {
        notes.push(`Skipped ${method.toUpperCase()} ${path}: unusual path parameters.`);
        continue;
      }

      const name = uniqueName(op.operationId ? snake(op.operationId) : `${method}_${path}`, names);
      let description = String(op.summary ?? op.description ?? "").trim().slice(0, 500);
      if (description.length < 10) description = `${method.toUpperCase()} ${path}${description ? `: ${description}` : ""}`;
      const input: InputSchema = { type: "object", properties, ...(required.length ? { required } : {}) };
      tools.push({
        name,
        title: String(op.summary ?? name).slice(0, 80),
        description,
        input,
        mutates: method !== "get",
        action: {
          kind: "http",
          method: method.toUpperCase() as HttpAction["method"],
          url: base + urlPath,
          ...(Object.keys(query).length ? { query } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
          ...(body ? { body } : {}),
          response: { maxChars: 20_000 },
        },
      });
    }
  }

  return {
    title: doc.info?.title,
    description: doc.info?.description ? String(doc.info.description).slice(0, 500) : undefined,
    tools,
    allowedHosts: [host],
    notes,
  };
}

/** Where to look for an API description on a site. */
export const OPENAPI_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/api/openapi.json",
  "/api/swagger.json",
  "/v3/api-docs",
  "/.well-known/openapi.json",
  "/api-docs",
];
