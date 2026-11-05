// Site profile format, v1.
//
// A profile is plain data describing a site's tools. It never contains code, so installing a
// community profile can't run someone else's JavaScript.
//
// Templates: strings may contain `{param}` placeholders filled from the tool's arguments.
// See template.ts for the exact rules. Browser-session tools may also use these anywhere in a
// request (headers, query, body); the user's browser tab fills them in at call time:
//   {$cookie:name}  a cookie of the site
//   {$meta:name}    a <meta name=…> tag of the page
//   {$live:name}    the latest value the site's own page sent for that header/field (login and
//                   anti-forgery codes like csrf tokens). Never stored in the profile.
// Any http tool may use {$uuid}, {$now} and {$rand:N} for ids the page invents per request.

import { z } from "zod";

export const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
export const SLUG = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

const Template = z.string();
const HttpsUrlTemplate = z.string().startsWith("https://");

/** A query or form value: a template string, or `{ json: … }` (filled like a JSON body, then sent as JSON text). */
export const ValueTemplateSchema = z.union([Template, z.object({ json: z.unknown() }).strict()]);

/** {$cookie:x} / {$meta:x} / {$live:x}: filled in the user's browser. */
export const BROWSER_PLACEHOLDER = /\{\$(cookie|meta|live):([^}]+)\}/g;

export const AuthSchema = z.enum(["none", "browser-session"]);

export const ResponseShapeSchema = z.object({
  /** Dot path into the JSON response to return, e.g. "hits" or "data.items" or "items.0". */
  pick: z.string().optional(),
  /** Keep only these fields (dot paths allowed) from the object, or from each item of an array. */
  fields: z.array(z.string()).optional(),
  /** Cap on the returned text. Default 20000. */
  maxChars: z.number().int().positive().max(500_000).optional(),
});

export const HttpActionSchema = z.object({
  kind: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: HttpsUrlTemplate,
  query: z.record(ValueTemplateSchema).optional(),
  headers: z.record(Template).optional(),
  body: z
    .object({
      encoding: z.enum(["json", "form"]),
      /**
       * json: any JSON value; string leaves may contain templates, "{x}" alone keeps the argument's type.
       * form: an object of field -> template string or { json }.
       */
      value: z.unknown(),
    })
    .optional(),
  response: ResponseShapeSchema.optional(),
});

/** Fills a form in a browser tab and submits it. Always runs in the browser. */
export const FormActionSchema = z.object({
  kind: z.literal("form"),
  /** Page to open before filling the form. */
  page: HttpsUrlTemplate,
  /** CSS selector of the form. */
  form: z.string().min(1),
  /** Tool argument name -> CSS selector (inside the form) of the field it fills. */
  fields: z.record(z.string()),
  /** CSS selector of the submit button; defaults to submitting the form. */
  submit: z.string().optional(),
  result: z
    .object({
      /** CSS selector to wait for after submitting. */
      waitFor: z.string().optional(),
      /** CSS selector whose text is returned. Defaults to the whole page. */
      read: z.string().optional(),
      maxChars: z.number().int().positive().max(500_000).optional(),
    })
    .optional(),
});

/** Opens a page (URL template) in a background tab and returns its text. For sites without an API. */
export const PageActionSchema = z.object({
  kind: z.literal("page"),
  url: HttpsUrlTemplate,
  query: z.record(ValueTemplateSchema).optional(),
  /** CSS selector to wait for before reading. */
  waitFor: z.string().optional(),
  /** CSS selector whose text is returned. Defaults to the page's main content. */
  read: z.string().optional(),
  maxChars: z.number().int().positive().max(500_000).optional(),
});

/** Calls a tool the site itself declares through WebMCP (navigator.modelContext). Experimental. */
export const WebMcpActionSchema = z.object({
  kind: z.literal("webmcp"),
  page: HttpsUrlTemplate,
  /** The tool's name as the page registers it. */
  tool: z.string().min(1),
});

/**
 * A tool of another MCP server the user connected to AnyMCP (see `anymcp server add`). Only made at
 * run time from that server's tool list; never in shared profiles.
 */
export const McpActionSchema = z.object({
  kind: z.literal("mcp"),
  /** The server's name in AnyMCP's config. */
  server: z.string().min(1),
  /** The tool's own name on that server. */
  tool: z.string().min(1),
  maxChars: z.number().int().positive().max(500_000).optional(),
});

export const ActionSchema = z.discriminatedUnion("kind", [HttpActionSchema, FormActionSchema, WebMcpActionSchema, PageActionSchema, McpActionSchema]);

export const InputSchemaSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.unknown()),
    required: z.array(z.string()).optional(),
  })
  .passthrough();

export const ToolSchema = z.object({
  name: z.string().regex(TOOL_NAME, "tool names are snake_case, 2-64 chars"),
  title: z.string().min(1),
  description: z.string().min(10),
  /** JSON Schema for the tool's arguments. */
  input: InputSchemaSchema,
  /** True if calling the tool changes data (posts, buys, deletes…). Asks the user every time. */
  mutates: z.boolean(),
  /** Overrides the profile's auth for this tool. */
  auth: AuthSchema.optional(),
  action: ActionSchema,
});

export const ProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Usually the site's domain, e.g. "github.com". */
    id: z.string().regex(SLUG),
    name: z.string().min(1),
    description: z.string().min(10),
    version: z.string().regex(SEMVER),
    authors: z.array(z.string()).min(1),
    categories: z.array(z.string().regex(SLUG)).min(1),
    /** Sites this profile belongs to. Used to suggest it when you visit them. */
    origins: z.array(z.string().regex(/^https:\/\/[^/]+$/, "origins look like https://example.com")).min(1),
    /** "none": runs in the gateway. "browser-session": runs in your logged-in tab via the extension. */
    auth: AuthSchema,
    /** The only hosts tools may send requests to or open pages on. */
    allowedHosts: z.array(z.string()).min(1),
    /**
     * How carefully to pace calls to this site. "strict" for sites that limit accounts that act
     * like bots (social networks). AnyMCP may pace a site more strictly than this, never less.
     */
    pace: z.enum(["strict", "normal", "relaxed"]).optional(),
    tools: z.array(ToolSchema).min(1),
  })
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    profile.tools.forEach((tool, i) => {
      if (seen.has(tool.name)) {
        ctx.addIssue({ code: "custom", path: ["tools", i, "name"], message: `duplicate tool name "${tool.name}"` });
      }
      seen.add(tool.name);

      if (tool.action.kind === "mcp") {
        ctx.addIssue({ code: "custom", path: ["tools", i, "action"], message: "MCP server tools can't be saved in profiles" });
        return;
      }
      const url = tool.action.kind === "http" || tool.action.kind === "page" ? tool.action.url : tool.action.page;
      const host = hostOfTemplate(url);
      if (!host || !profile.allowedHosts.includes(host)) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", i, "action"],
          message: `host "${host ?? url}" is not in allowedHosts`,
        });
      }
      if (host && /\{/.test(host)) {
        ctx.addIssue({ code: "custom", path: ["tools", i, "action"], message: "the host part of a URL can't be a template" });
      }

      if (tool.action.kind === "http") {
        const text = JSON.stringify(tool.action);
        const bad = /\{\$(?!((cookie|meta|live):[^}]+|uuid|now|rand:\d{1,3})\})[^}]*\}/.exec(text);
        if (bad) {
          ctx.addIssue({ code: "custom", path: ["tools", i, "action"], message: `unknown placeholder ${bad[0]} (use {$cookie:…}, {$meta:…}, {$live:…}, {$uuid}, {$now} or {$rand:N})` });
        }
        if ((tool.auth ?? profile.auth) === "none" && /\{\$(cookie|meta|live):/.test(text)) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", i, "action"],
            message: "{$cookie:…}, {$meta:…} and {$live:…} only work for browser-session tools",
          });
        }
      }

      const props = Object.keys(tool.input.properties);
      for (const r of tool.input.required ?? []) {
        if (!props.includes(r)) {
          ctx.addIssue({ code: "custom", path: ["tools", i, "input", "required"], message: `"${r}" is required but not defined` });
        }
      }
      if (tool.action.kind === "form") {
        for (const p of Object.keys(tool.action.fields)) {
          if (!props.includes(p)) {
            ctx.addIssue({ code: "custom", path: ["tools", i, "action", "fields"], message: `field "${p}" is not an input property` });
          }
        }
      }
    });
  });

export const CategorySchema = z.object({
  id: z.string().regex(SLUG),
  name: z.string().min(1),
  description: z.string(),
});

export const CategoriesFileSchema = z.object({
  schemaVersion: z.literal(1),
  categories: z.array(CategorySchema).min(1),
});

/** A curated bundle of profiles, e.g. "Developer pack". */
export const ListSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(SLUG),
  name: z.string().min(1),
  description: z.string().min(10),
  authors: z.array(z.string()).min(1),
  profiles: z.array(z.string().regex(SLUG)).min(1),
});

/** registry/index.json: everything a client needs, generated from the registry folder. */
export const RegistryIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  categories: z.array(CategorySchema),
  lists: z.array(ListSchema),
  /** Kept loose here so one bad profile doesn't reject the whole index; clients validate each. */
  profiles: z.array(z.unknown()),
});

export type Auth = z.infer<typeof AuthSchema>;
export type ResponseShape = z.infer<typeof ResponseShapeSchema>;
export type HttpAction = z.infer<typeof HttpActionSchema>;
export type FormAction = z.infer<typeof FormActionSchema>;
export type WebMcpAction = z.infer<typeof WebMcpActionSchema>;
export type PageAction = z.infer<typeof PageActionSchema>;
export type McpAction = z.infer<typeof McpActionSchema>;
export type ValueTemplate = z.infer<typeof ValueTemplateSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type InputSchema = z.infer<typeof InputSchemaSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type ProfileList = z.infer<typeof ListSchema>;
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;

/** Validates a profile and returns either it or readable error lines. */
export function validateProfile(data: unknown): { ok: true; profile: Profile } | { ok: false; errors: string[] } {
  const r = ProfileSchema.safeParse(data);
  if (r.success) return { ok: true, profile: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

export function hostOfTemplate(urlTemplate: string): string | undefined {
  try {
    // Only the path/query may hold templates; replace them so URL parsing works.
    const m = /^https:\/\/([^/?#]+)/.exec(urlTemplate);
    if (m?.[1]?.includes("{")) return m[1];
    return new URL(urlTemplate.replace(/\{[^}]+\}/g, "x")).host;
  } catch {
    return undefined;
  }
}

export function effectiveAuth(profile: Profile, tool: Tool): Auth {
  if (tool.action.kind === "mcp") return "none"; // runs in the gateway, through the other server
  if (tool.action.kind !== "http") return "browser-session"; // forms, pages and WebMCP need a tab
  return tool.auth ?? profile.auth;
}
