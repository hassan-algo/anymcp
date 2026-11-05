// Runs in the page's MAIN world on sites the user allowed. Remembers, in page memory only, the
// latest value the page itself sent for each request header, query parameter and top-level body
// field. Browser-session tools use these to fill {$live:…} (login and anti-forgery codes).
// Nothing is ever sent anywhere; the extension reads values only when one of the user's tools runs.

(() => {
  const KEY = Symbol.for("anymcp.live");
  const w = window as unknown as Record<symbol, unknown>;
  if (w[KEY]) return;

  const MAX_KEYS = 500;
  const MAX_VALUE = 8_192;
  const values = new Map<string, string>();

  function remember(key: string, value: unknown): void {
    try {
      let v = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof v !== "string" || v.length > MAX_VALUE) return;
      values.delete(key); // re-insert so the newest keys survive the cap
      values.set(key, v);
      while (values.size > MAX_KEYS) values.delete(values.keys().next().value as string);
    } catch {
      // ignore
    }
  }

  /** A field, plus the top-level keys inside it when it holds a JSON object (e.g. GraphQL `variables`). */
  function noteField(key: string, value: unknown): void {
    remember(`field:${key}`, value);
    try {
      let inner: unknown = value;
      if (typeof value === "string") {
        const t = value.trim();
        if (!t.startsWith("{") || t.length > 64_000) return;
        inner = JSON.parse(t);
      }
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        for (const [k, v] of Object.entries(inner as Record<string, unknown>).slice(0, 200)) remember(`field:${k}`, v);
      }
    } catch {
      // not JSON
    }
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

  function noteHeaders(h: unknown): void {
    for (const [k, v] of headerPairs(h)) {
      const name = k.toLowerCase();
      if (name !== "cookie") remember(`header:${name}`, v);
    }
  }

  function noteUrl(url: unknown): void {
    try {
      new URL(String(url), location.href).searchParams.forEach((v, k) => noteField(k, v));
    } catch {
      // ignore
    }
  }

  function noteBody(body: unknown): void {
    try {
      if (body === undefined || body === null) return;
      if (body instanceof URLSearchParams) {
        body.forEach((v, k) => noteField(k, v));
        return;
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        body.forEach((v, k) => {
          if (typeof v === "string") noteField(k, v);
        });
        return;
      }
      if (typeof body !== "string") return;
      const t = body.trim();
      if (t.startsWith("{")) {
        const o = JSON.parse(t);
        if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) noteField(k, v);
        return;
      }
      if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(t)) new URLSearchParams(t).forEach((v, k) => noteField(k, v));
    } catch {
      // ignore
    }
  }

  Object.defineProperty(window, KEY, {
    enumerable: false,
    value: Object.freeze({
      get(names: unknown): Record<string, string> {
        const out: Record<string, string> = {};
        if (!Array.isArray(names)) return out;
        for (const n of names) {
          const name = String(n);
          const v = values.get(`header:${name.toLowerCase()}`) ?? values.get(`field:${name}`);
          if (v !== undefined) out[name] = v;
        }
        return out;
      },
    }),
  });

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      try {
        const isReq = typeof Request !== "undefined" && input instanceof Request;
        noteUrl(isReq ? (input as Request).url : input instanceof URL ? input.href : input);
        if (isReq) noteHeaders((input as Request).headers);
        if (init?.headers) noteHeaders(init.headers);
        noteBody(init?.body);
      } catch {
        // never break the page
      }
      return origFetch.call(this ?? window, input, init);
    } as typeof window.fetch;
  }

  // ---- XMLHttpRequest ----
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSetHeader = proto.setRequestHeader;
  const origSend = proto.send;
  proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    noteUrl(args[1]);
    return (origOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof proto.open;
  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    try {
      if (String(name).toLowerCase() !== "cookie") remember(`header:${String(name).toLowerCase()}`, String(value));
    } catch {
      // ignore
    }
    return origSetHeader.call(this, name, value);
  };
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    noteBody(body);
    return origSend.call(this, body);
  };
})();
