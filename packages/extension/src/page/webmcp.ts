// Runs in the page's MAIN world at document_start on sites AnyMCP may access.
// If the page offers WebMCP tools (navigator.modelContext), this keeps a list of them so the
// extension can show and call them. Experimental: the WebMCP API is still changing, so every
// step is defensive and nothing here may throw into the page.

(() => {
  type PageTool = {
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: unknown;
    execute?: (args: unknown, agent?: unknown) => unknown;
  };

  const KEY = Symbol.for("anymcp.webmcp");
  const w = window as unknown as Record<symbol, unknown>;
  if (w[KEY]) return;

  const tools = new Map<string, PageTool>();

  const clone = (v: unknown) => {
    try {
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    } catch {
      return undefined;
    }
  };

  const add = (t: unknown) => {
    const tool = t as PageTool | null;
    if (tool && typeof tool.name === "string" && tool.name) tools.set(tool.name, tool);
  };

  const toText = (r: unknown): string => {
    if (typeof r === "string") return r;
    const content = (r as { content?: unknown } | null)?.content;
    if (Array.isArray(content)) {
      return content
        .map((c: { type?: string; text?: string }) => (c?.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c)))
        .join("\n");
    }
    try {
      return JSON.stringify(r) ?? String(r);
    } catch {
      return String(r);
    }
  };

  const api = {
    list: () =>
      [...tools.values()].map((t) => ({
        name: t.name,
        description: String(t.description ?? ""),
        inputSchema: clone(t.inputSchema),
        annotations: clone(t.annotations),
      })),
    call: async (name: string, args: unknown): Promise<string> => {
      const t = tools.get(name);
      if (!t || typeof t.execute !== "function") throw new Error(`The page has no WebMCP tool "${name}"`);
      const agent = { requestUserInteraction: async (cb: () => unknown) => cb() };
      return toText(await t.execute(args ?? {}, agent));
    },
  };
  try {
    Object.defineProperty(window, KEY, { value: api, enumerable: false });
  } catch {
    return;
  }

  let wrapped = false;
  const wrap = (): void => {
    if (wrapped) return;
    const mc = (navigator as unknown as { modelContext?: Record<string, unknown> }).modelContext;
    if (!mc || typeof mc !== "object") return;
    wrapped = true;

    const patch = (name: string, before: (...a: unknown[]) => void, after?: (result: unknown, ...a: unknown[]) => unknown) => {
      const orig = mc[name];
      if (typeof orig !== "function") return;
      try {
        mc[name] = function (this: unknown, ...args: unknown[]) {
          try {
            before(...args);
          } catch {
            // ignore
          }
          const result = (orig as (...a: unknown[]) => unknown).apply(this, args);
          try {
            return after ? after(result, ...args) : result;
          } catch {
            return result;
          }
        };
      } catch {
        // read-only property
      }
    };

    patch("provideContext", (ctx) => {
      tools.clear();
      const list = (ctx as { tools?: unknown[] } | null)?.tools;
      if (Array.isArray(list)) list.forEach(add);
    });
    patch(
      "registerTool",
      (t) => add(t),
      (result, t) => {
        const name = (t as PageTool | null)?.name;
        const reg = result as { unregister?: () => unknown } | null;
        if (name && reg && typeof reg.unregister === "function") {
          const orig = reg.unregister.bind(reg);
          reg.unregister = () => {
            tools.delete(name);
            return orig();
          };
        }
        return result;
      },
    );
    patch("unregisterTool", (n) => {
      tools.delete(typeof n === "string" ? n : String((n as PageTool | null)?.name ?? ""));
    });
    patch("clearContext", () => tools.clear());
  };

  wrap();
  if (!wrapped) {
    document.addEventListener("DOMContentLoaded", wrap, { once: true });
    window.addEventListener("load", wrap, { once: true });
  }
})();
