// Turns a form found on a page into a draft tool.

import { snake, uniqueName } from "./infer.js";
import type { Tool } from "./profile.js";

export interface FormField {
  name: string;
  /** CSS selector, relative to the form. */
  selector: string;
  type: string;
  label?: string;
  required: boolean;
  options?: string[];
}

export interface FormDescriptor {
  /** CSS selector of the form on the page. */
  selector: string;
  pageUrl: string;
  action: string;
  method: string;
  label?: string;
  fields: FormField[];
  submitSelector?: string;
}

const SKIP_TYPES = new Set(["hidden", "password", "file", "submit", "button", "reset", "image"]);

export function toolFromForm(form: FormDescriptor, taken = new Set<string>()): Tool | undefined {
  const fields = form.fields.filter((f) => !SKIP_TYPES.has(f.type) && f.name);
  if (!fields.length) return undefined;

  const params = new Set<string>();
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const map: Record<string, string> = {};
  for (const f of fields) {
    const name = uniqueName(f.name, params, "field");
    const type = f.type === "number" || f.type === "range" ? "number" : f.type === "checkbox" ? "boolean" : "string";
    properties[name] = {
      type,
      ...(f.label ? { description: f.label.slice(0, 200) } : {}),
      ...(f.options?.length ? { enum: f.options.slice(0, 50) } : {}),
    };
    if (f.required) required.push(name);
    map[name] = f.selector;
  }

  const isSearch = fields.some((f) => f.type === "search" || /^(q|query|search|s|k|keywords?)$/i.test(f.name));
  const actionPath = (() => {
    try {
      return new URL(form.action).pathname.split("/").filter(Boolean).pop() ?? "";
    } catch {
      return "";
    }
  })();
  const base = isSearch ? "search" : snake(form.label ?? "") || snake(actionPath) || "submit_form";
  const name = uniqueName(base.startsWith("submit") || isSearch ? base : `submit_${base}`, taken, "form");

  let page = form.pageUrl;
  try {
    const u = new URL(form.pageUrl);
    page = `${u.origin}${u.pathname}`; // drop query and hash: they often hold personal values
  } catch {
    // keep as is
  }

  return {
    name,
    title: (form.label ?? name.replace(/_/g, " ")).slice(0, 80),
    description: `Fills and submits the ${form.label ? `"${form.label}" ` : ""}form on ${page}. Recorded from the page; edit this description.`,
    input: { type: "object", properties, ...(required.length ? { required } : {}) },
    mutates: form.method.toUpperCase() !== "GET",
    action: {
      kind: "form",
      page,
      form: form.selector,
      fields: map,
      ...(form.submitSelector ? { submit: form.submitSelector } : {}),
    },
  };
}
