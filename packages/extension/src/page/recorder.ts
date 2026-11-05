// Runs in the page's MAIN world while recording. Wraps fetch and XMLHttpRequest and posts each
// API call (and each page the user opens) to the window, where relay.ts (ISOLATED world) picks it
// up. Header values are only kept when harmless; for anything else the recorder notes whether it
// equalled a cookie or meta tag ("cookie:x" / "meta:x") or must be filled live ("live").

(() => {
  const KEY = Symbol.for("anymcp.recorder");
  const w = window as unknown as Record<symbol, { active: boolean } | undefined>;
  if (w[KEY]) {
    w[KEY]!.active = true;
    (w[KEY] as unknown as { navigated?: (force?: boolean) => void }).navigated?.(true);
    return;
  }
  const state = { active: true };
  Object.defineProperty(window, KEY, { value: state, enumerable: false });

  const BODY_MAX = 4_000;
  const SAMPLE_MAX = 4_000;
  const SECRET_NAME = /auth|token|csrf|xsrf|session|secret|key|sig|claim|lsd|dtsg/i;

  function cookieMap(): Map<string, string> {
    const m = new Map<string, string>(); // value -> name
    try {
      for (const part of document.cookie.split(/;\s*/)) {
        const i = part.indexOf("=");
        if (i <= 0) continue;
        let v = part.slice(i + 1);
        try {
          v = decodeURIComponent(v);
        } catch {
          // keep raw
        }
        if (v.length >= 4) m.set(v, part.slice(0, i));
      }
    } catch {
      // ignore
    }
    return m;
  }

  function metaMap(): Map<string, string> {
    const m = new Map<string, string>();
    try {
      document.querySelectorAll<HTMLMetaElement>("meta[name][content], meta[property][content]").forEach((e) => {
        const name = e.getAttribute("name") ?? e.getAttribute("property") ?? "";
        if (e.content && e.content.length >= 8 && name) m.set(e.content, name);
      });
    } catch {
      // ignore
    }
    return m;
  }

  function refFor(value: string, cookies: Map<string, string>, metas: Map<string, string>): string | undefined {
    const c = cookies.get(value);
    if (c) return `cookie:${c}`;
    const m = metas.get(value);
    if (m) return `meta:${m}`;
    return undefined;
  }

  function harmless(name: string, value: string): boolean {
    return (
      value.length <= 40 &&
      /^[\w .,:;/=+-]*$/.test(value) &&
      !/(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}/.test(value) &&
      !SECRET_NAME.test(name)
    );
  }

  function headerList(pairs: [string, string][]): { name: string; value?: string; ref?: string }[] {
    const cookies = cookieMap();
    const metas = metaMap();
    const out: { name: string; value?: string; ref?: string }[] = [];
    for (const [k, v] of pairs.slice(0, 50)) {
      const name = k.toLowerCase();
      if (name === "cookie") continue;
      const ref = refFor(v, cookies, metas);
      if (ref) out.push({ name, ref });
      else if (harmless(name, v)) out.push({ name, value: v });
      else out.push({ name, ref: "live" });
    }
    return out;
  }

  function headerPairs(h: unknown): [string, string][] {
    try {
      if (!h) return [];
      if (typeof Headers !== "undefined" && h instanceof Headers) return [...h.entries()];
      if (Array.isArray(h)) return h.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [String(p[0]), String(p[1])]);
      if (typeof h === "object") return Object.entries(h as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
    } catch {
      // ignore
    }
    return [];
  }

  /** "query:k"/"body:k" -> "cookie:x"/"meta:x" for values that equal a cookie or meta tag. */
  function refsFor(url: string, body: string | undefined): Record<string, string> | undefined {
    const cookies = cookieMap();
    const metas = metaMap();
    const refs: Record<string, string> = {};
    try {
      new URL(url).searchParams.forEach((v, k) => {
        const r = refFor(v, cookies, metas);
        if (r) refs[`query:${k}`] = r;
      });
    } catch {
      // ignore
    }
    if (body) {
      try {
        const t = body.trim();
        if (t.startsWith("{")) {
          const o = JSON.parse(t);
          if (o && typeof o === "object") {
            for (const [k, v] of Object.entries(o)) {
              const r = typeof v === "string" ? refFor(v, cookies, metas) : undefined;
              if (r) refs[`body:${k}`] = r;
            }
          }
        } else if (t.includes("=")) {
          new URLSearchParams(t).forEach((v, k) => {
            const r = refFor(v, cookies, metas);
            if (r) refs[`body:${k}`] = r;
          });
        }
      } catch {
        // ignore
      }
    }
    return Object.keys(refs).length ? refs : undefined;
  }

  function abs(url: string): string {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  function bodyToString(body: unknown): { text?: string; type?: string } {
    if (body === undefined || body === null) return {};
    if (typeof body === "string") return { text: body.slice(0, BODY_MAX) };
    if (body instanceof URLSearchParams) return { text: body.toString().slice(0, BODY_MAX), type: "application/x-www-form-urlencoded" };
    if (body instanceof FormData) {
      const p = new URLSearchParams();
      body.forEach((v, k) => {
        if (typeof v === "string") p.append(k, v);
      });
      return { text: p.toString().slice(0, BODY_MAX), type: "application/x-www-form-urlencoded" };
    }
    return {};
  }

  function post(request: Record<string, unknown>): void {
    if (!state.active) return;
    try {
      window.postMessage({ source: "anymcp-recorder", request }, "*");
    } catch {
      // ignore
    }
  }

  // ---- Page visits (top frame only) ----
  let lastNav = "";
  function navigated(force = false): void {
    if (window.top !== window) return;
    const url = location.href;
    if (url === lastNav && !force) return;
    lastNav = url;
    post({ kind: "navigation", method: "GET", url, status: 200 });
  }
  (state as unknown as { navigated: (force?: boolean) => void }).navigated = navigated;
  // The relay may not be listening yet at document_start.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(() => navigated(), 0), { once: true });
  else setTimeout(() => navigated(), 0);
  for (const fn of ["pushState", "replaceState"] as const) {
    const orig = history[fn];
    history[fn] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      try {
        setTimeout(() => navigated(), 0);
      } catch {
        // ignore
      }
      return r;
    };
  }
  window.addEventListener("popstate", () => setTimeout(() => navigated(), 0));

  // ---- fetch ----
  const origFetch = window.fetch;
  window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const res = await origFetch.call(this ?? window, input, init);
    if (!state.active) return res;
    try {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const method = (init?.method ?? (isReq ? (input as Request).method : "GET")).toUpperCase();
      const url = abs(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      const body = bodyToString(init?.body);
      let reqType = body.type;
      const pairs = [...(isReq ? headerPairs((input as Request).headers) : []), ...headerPairs(init?.headers)];
      const ct = pairs.filter(([k]) => k.toLowerCase() === "content-type").pop()?.[1];
      if (ct) reqType = ct;
      const resType = res.headers.get("content-type") ?? "";
      let sample: string | undefined;
      if (/json/i.test(resType)) {
        sample = (await res.clone().text()).slice(0, SAMPLE_MAX);
      }
      post({
        method,
        url,
        requestBody: body.text,
        requestContentType: reqType,
        status: res.status,
        responseContentType: resType,
        responseSample: sample,
        headers: headerList(pairs),
        refs: refsFor(url, body.text),
      });
    } catch {
      // never break the page
    }
    return res;
  } as typeof window.fetch;

  // ---- XMLHttpRequest ----
  type Info = { method: string; url: string; type?: string; body?: string; headers: [string, string][] };
  const infos = new WeakMap<XMLHttpRequest, Info>();
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSetHeader = proto.setRequestHeader;
  const origSend = proto.send;

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      infos.set(this, { method: String(method).toUpperCase(), url: abs(String(url)), headers: [] });
    } catch {
      // ignore
    }
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    try {
      const i = infos.get(this);
      if (i) {
        i.headers.push([String(name), String(value)]);
        if (name.toLowerCase() === "content-type") i.type = value;
      }
    } catch {
      // ignore
    }
    return origSetHeader.call(this, name, value);
  };

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const info = infos.get(this);
      if (info) {
        const b = bodyToString(body);
        info.body = b.text;
        info.type ??= b.type;
        this.addEventListener("loadend", () => {
          try {
            const resType = this.getResponseHeader("content-type") ?? "";
            let sample: string | undefined;
            if (/json/i.test(resType)) {
              if (this.responseType === "" || this.responseType === "text") sample = this.responseText.slice(0, SAMPLE_MAX);
              else if (this.responseType === "json") sample = JSON.stringify(this.response).slice(0, SAMPLE_MAX);
            }
            post({
              method: info.method,
              url: info.url,
              requestBody: info.body,
              requestContentType: info.type,
              status: this.status,
              responseContentType: resType,
              responseSample: sample,
              headers: headerList(info.headers),
              refs: refsFor(info.url, info.body),
            });
          } catch {
            // ignore
          }
        });
      }
    } catch {
      // ignore
    }
    return origSend.call(this, body);
  };
})();
