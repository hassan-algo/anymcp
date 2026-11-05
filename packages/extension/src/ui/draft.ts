// Draft profiles: building them from recordings, the editor, and turning them into a
// profile. Used by the setup window.

import {
  hostOfTemplate,
  inferTools,
  uniqueName,
  validateProfile,
  type Auth,
  type CapturedRequest,
  type Category,
  type Tool,
} from "@anymcp/shared";
import { h } from "./dom.js";

export interface DraftTool {
  tool: Tool;
  include: boolean;
  source: string;
}

export interface Draft {
  origin: string;
  id: string;
  name: string;
  description: string;
  authors: string;
  categories: Set<string>;
  auth: Auth;
  tools: DraftTool[];
  notes: string[];
  errors: string[];
}

export function defaultId(origin: string): string {
  return new URL(origin).hostname.replace(/^www\./, "").toLowerCase();
}

export function createDraft(origin: string, pageTitle?: string): Draft {
  const id = defaultId(origin);
  return {
    origin,
    id,
    name: pageTitle?.split(/[|\-–—·:]/)[0]?.trim().slice(0, 60) || id,
    description: `Tools for ${id}.`,
    authors: "you",
    categories: new Set(),
    auth: "browser-session",
    tools: [],
    notes: [],
    errors: [],
  };
}

/** Tools that need the user's browser: pages, forms, WebMCP, or requests using browser placeholders. */
export function needsBrowser(t: Tool): boolean {
  return t.action.kind !== "http" || /\{\$(cookie|meta|live):/.test(JSON.stringify(t.action));
}

/** Short label for what kind of tool this is. */
export function toolKind(t: Tool): string {
  const a = t.action;
  if (a.kind === "page") return "page";
  if (a.kind === "form") return "form";
  if (a.kind === "webmcp") return "WebMCP";
  return /graphql|doc_id|operationName|queryId/i.test(JSON.stringify(a)) ? "GraphQL" : "API";
}

export function addTools(d: Draft, tools: Tool[], source: string, notes: string[]): void {
  const taken = new Set(d.tools.map((t) => t.tool.name));
  for (const tool of tools) {
    const name = taken.has(tool.name) ? uniqueName(tool.name, taken) : (taken.add(tool.name), tool.name);
    d.tools.push({ tool: { ...tool, name }, include: true, source });
  }
  d.notes.push(...notes);
}

/** Turns recorded activity into draft tools. Returns how many tools were made. */
export function applyRecording(d: Draft, requests: CapturedRequest[]): number {
  const res = inferTools(requests);
  if (res.tools.length) addTools(d, res.tools, "recorded", res.notes);
  return res.tools.length;
}

export function buildProfile(d: Draft): unknown {
  const tools = d.tools.filter((t) => t.include).map((t) => t.tool);
  const hosts = new Set<string>();
  for (const t of tools) {
    const u = t.action.kind === "http" || t.action.kind === "page" ? t.action.url : "page" in t.action ? t.action.page : "";
    const hst = hostOfTemplate(u);
    if (hst) hosts.add(hst);
  }
  return {
    schemaVersion: 1,
    id: d.id.trim(),
    name: d.name.trim(),
    description: d.description.trim(),
    version: "0.1.0",
    authors: d.authors.split(",").map((a) => a.trim()).filter(Boolean),
    categories: [...d.categories],
    origins: [d.origin],
    auth: tools.some(needsBrowser) ? "browser-session" : d.auth,
    allowedHosts: [...hosts],
    tools,
  };
}

/** Checks a draft. Returns the profile to save, or undefined with `d.errors` filled in. */
export function checkDraft(d: Draft): unknown | undefined {
  d.errors = [];
  if (!d.tools.some((t) => t.include)) d.errors.push("Pick at least one tool.");
  if (!d.categories.size) d.errors.push("Pick at least one category.");
  const profile = buildProfile(d);
  const v = validateProfile(profile);
  if (!v.ok) d.errors.push(...v.errors);
  return d.errors.length ? undefined : profile;
}

export interface EditorOptions {
  categories: Category[];
  onSave: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
}

/** The draft editor: profile fields, categories, how tools run, and each tool. */
export function renderDraftEditor(d: Draft, opts: EditorOptions): HTMLElement {
  const bind = (key: "id" | "name" | "description" | "authors") => (e: Event) => {
    d[key] = (e.target as HTMLInputElement).value;
  };
  const browserOnly = d.tools.some((t) => t.include && needsBrowser(t.tool));

  const toolRows = d.tools.map((dt) => {
    const t = dt.tool;
    const row = h(
      "div",
      { class: `tool-edit${dt.include ? "" : " excluded"}` },
      h(
        "div",
        { class: "row spread" },
        h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            checked: dt.include,
            onChange: (e: Event) => {
              dt.include = (e.target as HTMLInputElement).checked;
              row.classList.toggle("excluded", !dt.include);
            },
          }),
          "Include",
        ),
        h(
          "span",
          { class: "row" },
          h("span", { class: "badge plain" }, dt.source),
          h("span", { class: "badge plain" }, toolKind(t)),
          t.mutates && h("span", { class: "badge warn" }, "changes data"),
        ),
      ),
      h(
        "div",
        { class: "grid2" },
        h(
          "div",
          {},
          h("label", { class: "field" }, "Name"),
          h("input", { type: "text", value: t.name, onInput: (e: Event) => (t.name = (e.target as HTMLInputElement).value.trim()) }),
        ),
        h(
          "div",
          {},
          h("label", { class: "field" }, "Title"),
          h("input", { type: "text", value: t.title, onInput: (e: Event) => (t.title = (e.target as HTMLInputElement).value) }),
        ),
      ),
      h("label", { class: "field" }, "Description (what the AI reads)"),
      h("textarea", { value: t.description, onInput: (e: Event) => (t.description = (e.target as HTMLTextAreaElement).value) }),
      h(
        "div",
        { class: "row spread", style: "margin-top:6px" },
        h(
          "label",
          { class: "check" },
          h("input", { type: "checkbox", checked: t.mutates, onChange: (e: Event) => (t.mutates = (e.target as HTMLInputElement).checked) }),
          "Changes data (asks before every use)",
        ),
      ),
      h("details", {}, h("summary", {}, "Details"), h("pre", {}, JSON.stringify({ input: t.input, action: t.action }, null, 2))),
    );
    return row;
  });

  return h(
    "div",
    { class: "card stack draft", style: "margin-top:10px" },
    h(
      "div",
      { class: "row spread" },
      h("h3", {}, `Draft profile (${d.tools.length} tools)`),
      opts.onDiscard && h("button", { class: "link", onClick: opts.onDiscard }, "Discard"),
    ),
    h(
      "div",
      { class: "grid2" },
      h("div", {}, h("label", { class: "field" }, "Name"), h("input", { type: "text", value: d.name, onInput: bind("name") })),
      h("div", {}, h("label", { class: "field" }, "Id"), h("input", { type: "text", value: d.id, onInput: bind("id") })),
    ),
    h("div", {}, h("label", { class: "field" }, "Description"), h("textarea", { value: d.description, onInput: bind("description") })),
    h("div", {}, h("label", { class: "field" }, "Authors (comma separated)"), h("input", { type: "text", value: d.authors, onInput: bind("authors") })),
    h(
      "div",
      {},
      h("label", { class: "field" }, "Categories"),
      opts.categories.length
        ? h(
            "div",
            { class: "cats" },
            opts.categories.map((c) =>
              h(
                "label",
                { class: "check", title: c.description },
                h("input", {
                  type: "checkbox",
                  checked: d.categories.has(c.id),
                  onChange: (e: Event) => ((e.target as HTMLInputElement).checked ? d.categories.add(c.id) : d.categories.delete(c.id)),
                }),
                c.name,
              ),
            ),
          )
        : h("input", {
            type: "text",
            placeholder: "e.g. productivity, dev",
            value: [...d.categories].join(", "),
            onInput: (e: Event) => {
              d.categories = new Set((e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean));
            },
          }),
    ),
    h(
      "div",
      {},
      h("label", { class: "field" }, "How tools run"),
      h(
        "select",
        { disabled: browserOnly, onChange: (e: Event) => (d.auth = (e.target as HTMLSelectElement).value as Auth) },
        h("option", { value: "browser-session", selected: browserOnly || d.auth === "browser-session" }, "In my logged-in browser (recommended)"),
        h("option", { value: "none", selected: !browserOnly && d.auth === "none" }, "Public: without the browser (API calls only)"),
      ),
      browserOnly && h("p", { class: "small muted", style: "margin:4px 0 0" }, "These tools use your login or open pages, so they run in your browser."),
    ),
    d.notes.length > 0 && h("div", { class: "notice warn" }, h("ul", { class: "errors", style: "color:inherit;margin:0" }, [...new Set(d.notes)].map((n) => h("li", {}, n)))),
    h("div", {}, h("h2", { style: "margin-top:6px" }, "Tools"), toolRows),
    d.errors.length > 0 && h("ul", { class: "errors" }, d.errors.map((e) => h("li", {}, e))),
    h("div", { class: "row" }, h("button", { class: "primary", onClick: opts.onSave }, opts.saveLabel ?? "Save profile")),
  );
}
