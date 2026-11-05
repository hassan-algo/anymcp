// Functions injected into pages with chrome.scripting.executeScript.
//
// Chrome sends each function's source text to the page, so every function here must be
// self-contained: no imports, no outer variables, no helpers defined elsewhere. Type-only
// imports are fine (they disappear at build time). Errors are returned as { __error } because
// a throw inside an injected function doesn't reach the caller reliably.

import type { FormDescriptor, PageElement, ResolvedHttpRequest } from "@anymcp/shared";

export type InjectedError = { __error: string };

export function extractPage(maxChars: number): { title: string; url: string; text: string; truncated: boolean; htmlChars: number } {
  const raw = document.body?.innerText ?? "";
  const text = raw
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: document.title, url: location.href, text: text.slice(0, maxChars), truncated: text.length > maxChars, htmlChars: document.documentElement.outerHTML.length };
}

/** Scrolls down a little, like a person would, so the page loads its "more" data. Returns false at the bottom. */
export function scrollDown(): boolean {
  const before = window.scrollY;
  window.scrollBy({ top: Math.max(600, window.innerHeight * 1.5), behavior: "instant" as ScrollBehavior });
  return window.scrollY > before;
}

/** Text of the elements matching `selector` (or the whole page). */
export function readText(selector: string | null, maxChars: number): { title: string; url: string; text: string; truncated: boolean; htmlChars: number } {
  const els = selector ? Array.from(document.querySelectorAll<HTMLElement>(selector)) : [document.body];
  const raw = els.map((e) => e?.innerText ?? "").join("\n\n");
  const text = raw
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const htmlChars = document.documentElement.outerHTML.length;
  return { title: document.title, url: location.href, text: text.slice(0, maxChars), truncated: text.length > maxChars, htmlChars };
}

/** Text of `selector`, or of the page's main content (main, [role=main], article, else body). */
export function readMain(
  selector: string | null,
  maxChars: number,
): { title: string; url: string; text: string; truncated: boolean; length: number; htmlChars: number } {
  let els: HTMLElement[];
  if (selector) els = Array.from(document.querySelectorAll<HTMLElement>(selector));
  else {
    const main = document.querySelector<HTMLElement>("main, [role=main]") ?? document.querySelector<HTMLElement>("article");
    els = [main && (main.innerText ?? "").trim().length > 40 ? main : document.body];
  }
  const raw = els.map((e) => e?.innerText ?? "").join("\n\n");
  const text = raw
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const htmlChars = document.documentElement.outerHTML.length;
  return { title: document.title, url: location.href, text: text.slice(0, maxChars), truncated: text.length > maxChars, length: text.length, htmlChars };
}

export function hasSelector(selector: string): boolean {
  try {
    return document.readyState !== "loading" && document.querySelector(selector) !== null;
  } catch {
    return false;
  }
}

export function findElements(query: string | null, limit: number): { url: string; elements: PageElement[] } {
  const w = window as unknown as { __anymcpRef?: number };
  const SEL =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="combobox"], [onclick], [contenteditable="true"], [contenteditable=""]';
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  const roleOf = (el: Element) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el as HTMLInputElement).type;
      if (t === "checkbox" || t === "radio") return t;
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      return "textbox";
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    return "button";
  };
  const nameOf = (el: Element) => {
    const h = el as HTMLElement;
    const aria = el.getAttribute("aria-label");
    if (clean(aria)) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(t)) return clean(t);
    }
    if (h.id) {
      const l = document.querySelector(`label[for="${CSS.escape(h.id)}"]`);
      if (l && clean(l.textContent)) return clean(l.textContent);
    }
    const tag = el.tagName.toLowerCase();
    if (tag !== "select") {
      const parentLabel = el.closest("label");
      if (parentLabel && clean(parentLabel.textContent)) return clean(parentLabel.textContent);
    }
    if (tag !== "input" && tag !== "select" && tag !== "textarea") {
      const text = clean(h.innerText);
      if (text) return text;
    }
    return clean(
      el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        (tag === "input" && ["submit", "button"].includes((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : "") ||
        el.getAttribute("name") ||
        el.querySelector("img")?.getAttribute("alt"),
    );
  };

  const q = query ? query.toLowerCase() : null;
  const out: PageElement[] = [];
  for (const el of Array.from(document.querySelectorAll(SEL))) {
    if (out.length >= limit) break;
    if (!visible(el)) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    const href = el instanceof HTMLAnchorElement ? el.href : undefined;
    if (q && !`${role} ${name} ${href ?? ""}`.toLowerCase().includes(q)) continue;
    let ref = el.getAttribute("data-anymcp-ref");
    if (!ref) {
      w.__anymcpRef = (w.__anymcpRef ?? 0) + 1;
      ref = `e${w.__anymcpRef}`;
      el.setAttribute("data-anymcp-ref", ref);
    }
    const item: PageElement = { ref, role, name };
    if (href) item.href = href;
    if (el instanceof HTMLInputElement) {
      item.type = el.type;
      if (el.type === "checkbox" || el.type === "radio") item.value = String(el.checked);
      else if (el.type !== "password" && el.value) item.value = el.value.slice(0, 100);
    } else if ((el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && el.value) {
      item.value = el.value.slice(0, 100);
    }
    out.push(item);
  }
  return { url: location.href, elements: out };
}

export function clickElement(selector: string): { clicked: string } | InjectedError {
  try {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return { __error: `Nothing on the page matches ${selector}. Call find_elements again; refs reset when the page reloads.` };
    const label = (el.getAttribute("aria-label") || el.innerText || (el as HTMLInputElement).value || el.tagName).trim().slice(0, 80);
    el.scrollIntoView({ block: "center", inline: "center" });
    // Send the events a real click sends, at a point inside the element: many sites open menus
    // on pointerdown, or ignore clicks that come with no press.
    const box = el.getBoundingClientRect();
    const x = box.left + box.width * (0.3 + Math.random() * 0.4);
    const y = box.top + box.height * (0.3 + Math.random() * 0.4);
    const at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    const pointer = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerover", pointer));
    el.dispatchEvent(new MouseEvent("mouseover", at));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, button: 0, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...at, button: 0, buttons: 1 }));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, button: 0, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...at, button: 0, buttons: 0 }));
    el.click();
    return { clicked: label };
  } catch (e) {
    return { __error: (e as Error).message };
  }
}

/**
 * Fills fields and optionally submits. Used by the fill tool and by form tools.
 * Field selectors are looked up inside `rootSelector` first, then the whole page.
 * Submitting is deferred so this returns before the page navigates.
 */
export function fillFields(
  rootSelector: string | null,
  entries: [string, string][],
  submitSelector: string | null,
  submit: boolean,
): { filled: number; submitted: boolean } | InjectedError {
  try {
    let root: ParentNode = document;
    if (rootSelector) {
      const r = document.querySelector(rootSelector);
      if (!r) return { __error: `No form matches ${rootSelector} on ${location.href}.` };
      root = r;
    }
    const find = (sel: string) => root.querySelector(sel) ?? document.querySelector(sel);
    let last: Element | null = null;

    for (const [selector, value] of entries) {
      let el = find(selector);
      if (!el) return { __error: `Nothing on the page matches ${selector}.` };
      (el as HTMLElement).scrollIntoView?.({ block: "center" });
      (el as HTMLElement).focus?.({ preventScroll: true });

      if (el instanceof HTMLSelectElement) {
        const v = value.trim().toLowerCase();
        const opts = Array.from(el.options);
        const opt = opts.find((o) => o.value === value) ?? opts.find((o) => o.text.trim().toLowerCase() === v);
        if (!opt) return { __error: `"${value}" is not an option of ${selector}. Options: ${opts.map((o) => o.text.trim()).slice(0, 20).join(", ")}` };
        el.value = opt.value;
      } else if (el instanceof HTMLInputElement && el.type === "radio") {
        const match = find(`${selector}[value="${CSS.escape(value)}"]`);
        if (match instanceof HTMLInputElement) el = match;
        const radio = el as HTMLInputElement;
        if (!radio.checked) radio.click();
        last = radio;
        continue;
      } else if (el instanceof HTMLInputElement && el.type === "checkbox") {
        const want = /^(true|1|yes|on|checked)$/i.test(value.trim());
        if (el.checked !== want) el.click();
        last = el;
        continue;
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
      } else if ((el as HTMLElement).isContentEditable) {
        const h = el as HTMLElement;
        h.focus();
        document.execCommand("selectAll");
        if (!document.execCommand("insertText", false, value)) h.textContent = value;
      } else {
        return { __error: `${selector} is not a field you can type in.` };
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      last = el;
    }

    if (!submit) return { filled: entries.length, submitted: false };

    let button: HTMLElement | null = null;
    if (submitSelector) {
      button = find(submitSelector) as HTMLElement | null;
      if (!button) return { __error: `No submit button matches ${submitSelector}.` };
    }
    const form =
      root instanceof HTMLFormElement
        ? root
        : ((last as HTMLInputElement | null)?.form ?? last?.closest("form") ?? null);
    const target = last as HTMLElement | null;
    setTimeout(() => {
      if (button) button.click();
      else if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      } else if (target) {
        for (const type of ["keydown", "keypress", "keyup"]) {
          target.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
      }
    }, 0);
    return { filled: entries.length, submitted: true };
  } catch (e) {
    return { __error: (e as Error).message };
  }
}

/** Sends an already-filled request from the page, with the user's cookies. */
export async function fetchInPage(
  req: ResolvedHttpRequest,
  maxChars: number,
): Promise<{ status: number; url: string; contentType: string; body: string; retryAfter?: string } | InjectedError> {
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: "include" });
    const text = await res.text();
    const out: { status: number; url: string; contentType: string; body: string; retryAfter?: string } = {
      status: res.status,
      url: res.url,
      contentType: res.headers.get("content-type") ?? "",
      body: text.slice(0, maxChars),
    };
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) out.retryAfter = retryAfter;
    return out;
  } catch (e) {
    return { __error: `The request failed in the browser: ${(e as Error).message}` };
  }
}

/**
 * Finds values for {$cookie:…}/{$meta:…}/{$live:…} keys ("kind:name"). Runs in the MAIN world.
 * Live values come from the page's own latest requests (page/live.ts); with `fallbacks`, also
 * from known patterns in the HTML, hidden inputs, meta tags, cookies and a generic pattern.
 */
export function collectBrowserValues(
  keys: string[],
  fallbacks: boolean,
  patterns: Record<string, string[]>,
  generic: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const cookies: Record<string, string> = {};
    for (const part of document.cookie.split(/;\s*/)) {
      const i = part.indexOf("=");
      if (i <= 0) continue;
      try {
        cookies[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
      } catch {
        cookies[part.slice(0, i)] = part.slice(i + 1);
      }
    }
    const meta = (name: string): string | undefined => {
      const e = CSS.escape(name);
      return document.querySelector<HTMLMetaElement>(`meta[name="${e}"], meta[property="${e}"], meta[http-equiv="${e}"]`)?.content ?? undefined;
    };
    const hook = (window as unknown as Record<symbol, { get(n: string[]): Record<string, string> } | undefined>)[Symbol.for("anymcp.live")];
    const liveNames = keys.filter((k) => k.startsWith("live:")).map((k) => k.slice(5));
    const fromHook = hook ? hook.get(liveNames) : {};
    let html: string | undefined;
    const pageHtml = () => (html ??= (document.documentElement?.outerHTML ?? "").slice(0, 3_000_000));
    const match = (source: string): string | undefined => {
      try {
        return new RegExp(source).exec(pageHtml())?.[1];
      } catch {
        return undefined;
      }
    };

    for (const key of keys) {
      const i = key.indexOf(":");
      const kind = key.slice(0, i);
      const name = key.slice(i + 1);
      let v: string | undefined;
      if (kind === "cookie") v = cookies[name];
      else if (kind === "meta") v = meta(name);
      else if (kind === "live") {
        v = fromHook[name];
        if (v === undefined && fallbacks) {
          for (const src of patterns[name.toLowerCase()] ?? []) {
            v = match(src);
            if (v !== undefined) break;
          }
          v ??= document.querySelector<HTMLInputElement>(`input[name="${CSS.escape(name)}"]`)?.value || undefined;
          v ??= meta(name);
          v ??= cookies[name];
          if (v === undefined && generic[name]) v = match(generic[name]!);
        }
      }
      if (v !== undefined) out[key] = v;
    }
  } catch {
    // return what we have
  }
  return out;
}

/** Lists forms on the page that could become tools. Login forms are skipped. */
export function scanForms(): { forms: FormDescriptor[]; skippedLoginForms: number } {
  const cssPath = (el: Element): string => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const labelOf = (el: HTMLElement): string | undefined => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (clean(l?.textContent)) return clean(l?.textContent).slice(0, 120);
    }
    const parent = el.closest("label");
    if (clean(parent?.textContent)) return clean(parent?.textContent).slice(0, 120);
    return clean(el.getAttribute("placeholder") || el.getAttribute("title")) || undefined;
  };

  const forms: FormDescriptor[] = [];
  let skippedLoginForms = 0;
  for (const form of Array.from(document.forms)) {
    const r = form.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (form.querySelector('input[type="password"]')) {
      skippedLoginForms++;
      continue;
    }
    let selector: string;
    if (form.id) selector = `#${CSS.escape(form.id)}`;
    else if (form.getAttribute("name")) selector = `form[name="${CSS.escape(form.getAttribute("name")!)}"]`;
    else if (form.getAttribute("action") && document.querySelectorAll(`form[action="${CSS.escape(form.getAttribute("action")!)}"]`).length === 1) {
      selector = `form[action="${CSS.escape(form.getAttribute("action")!)}"]`;
    } else selector = cssPath(form);

    const fields: FormDescriptor["fields"] = [];
    const seen = new Set<string>();
    for (const el of Array.from(form.elements)) {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
      const name = el.name;
      if (!name || seen.has(name)) continue;
      const type = el instanceof HTMLInputElement ? el.type : el instanceof HTMLSelectElement ? "select" : "textarea";
      seen.add(name);
      let options: string[] | undefined;
      if (el instanceof HTMLSelectElement) options = Array.from(el.options).map((o) => o.value || o.text).filter(Boolean);
      if (el instanceof HTMLInputElement && type === "radio") {
        options = Array.from(form.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`)).map((o) => o.value);
      }
      fields.push({
        name,
        selector: `[name="${CSS.escape(name)}"]`,
        type,
        label: labelOf(el),
        required: el.required,
        ...(options?.length ? { options } : {}),
      });
    }

    const legend = clean(form.querySelector("legend")?.textContent);
    const aria = clean(form.getAttribute("aria-label"));
    const role = form.getAttribute("role") === "search" || form.closest('[role="search"]') ? "Search" : "";
    forms.push({
      selector,
      pageUrl: location.href,
      action: form.action || location.href,
      method: (form.getAttribute("method") || "GET").toUpperCase(),
      label: (aria || legend || role || undefined)?.slice(0, 80),
      fields,
    });
  }
  return { forms, skippedLoginForms };
}

/** Looks for an OpenAPI document and an official AnyMCP profile on the site. */
export async function discoverApis(paths: string[]): Promise<{ openapi?: { url: string; doc: Record<string, unknown> }; official?: unknown }> {
  const MAX = 5_000_000;
  const getJson = async (path: string): Promise<unknown> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(new URL(path, location.origin).href, { credentials: "same-origin", signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return undefined;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX) return undefined;
      const text = await res.text();
      if (text.length > MAX || !/^\s*[{[]/.test(text)) return undefined;
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const out: { openapi?: { url: string; doc: Record<string, unknown> }; official?: unknown } = {};
  const official = await getJson("/.well-known/anymcp.json");
  if (official && typeof official === "object") out.official = official;
  for (const p of paths) {
    const doc = await getJson(p);
    if (doc && typeof doc === "object" && ("openapi" in doc || "swagger" in doc) && "paths" in doc) {
      out.openapi = { url: new URL(p, location.origin).href, doc: doc as Record<string, unknown> };
      break;
    }
  }
  return out;
}

// ---- MAIN world helpers -----------------------------------------------------

export function webmcpList(): { available: boolean; tools: { name: string; description: string; inputSchema?: unknown; annotations?: unknown }[] } {
  const api = (window as unknown as Record<symbol, { list(): never[] } | undefined>)[Symbol.for("anymcp.webmcp")];
  if (!api) return { available: false, tools: [] };
  try {
    return { available: true, tools: api.list() };
  } catch {
    return { available: true, tools: [] };
  }
}

export async function webmcpCall(name: string, args: Record<string, unknown>, waitMs: number): Promise<{ text: string } | InjectedError> {
  type Api = { list(): { name: string }[]; call(name: string, args: unknown): Promise<string> };
  const key = Symbol.for("anymcp.webmcp");
  const deadline = Date.now() + waitMs;
  // Sites often register tools a moment after load.
  for (;;) {
    const api = (window as unknown as Record<symbol, Api | undefined>)[key];
    if (api && api.list().some((t) => t.name === name)) {
      try {
        return { text: await api.call(name, args) };
      } catch (e) {
        return { __error: `The page's "${name}" tool failed: ${(e as Error)?.message ?? String(e)}` };
      }
    }
    if (Date.now() > deadline) {
      return {
        __error: api
          ? `The page doesn't offer a WebMCP tool named "${name}".`
          : "This page has no WebMCP tools, or it loaded before AnyMCP had access. Reload the page and try again.",
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Turns the recorder in this page on or off. */
export function setRecorderActive(active: boolean): void {
  const key = Symbol.for("anymcp.recorder");
  const w = window as unknown as Record<symbol, { active: boolean } | undefined>;
  const state = w[key];
  if (state) state.active = active;
}
