// Runs a profile tool: checks arguments and approvals, then sends the request from the gateway
// (public tools) or from the user's browser (logged-in tools, forms, pages, WebMCP).

import {
  checkArgs,
  effectiveAuth,
  compactContent,
  hostAllowed,
  isLoginUrl,
  looksBlocked,
  looksSignedOut,
  resolveFormAction,
  resolveHttpRequest,
  resolvePageAction,
  resolveWebMcpPage,
  retryAfterMs,
  shapeResponse,
  TemplateError,
  truncate,
  type ExtensionMethods,
  type HttpResult,
  type MethodName,
  type Profile,
  type Tool,
} from "@anymcp/shared";
import { ApprovalError, type Approvals } from "./approvals.js";
import { callContext } from "./ask.js";
import type { Catalog } from "./catalog.js";
import { PaceError, type Pacer } from "./pacing.js";

export interface ToolResult {
  [key: string]: unknown;
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export interface BrowserCaller {
  readonly connected: boolean;
  call<M extends MethodName>(method: M, params: ExtensionMethods[M]["params"], timeoutMs?: number): Promise<ExtensionMethods[M]["result"]>;
}

export interface ExecutorDeps {
  catalog: Catalog;
  browser: BrowserCaller;
  approvals: Approvals;
  version: string;
  fetch?: typeof fetch;
  /** Called after each API call with what the site sent and what the AI got (characters). */
  recordUsage?: (profileId: string, rawChars: number, returnedChars: number) => void;
  /** Called after a tool reached the site: ok=false when the site call failed. */
  onToolResult?: (toolId: string, ok: boolean) => void;
  /** Called after a page read with the page's HTML size and the text the AI got (characters). */
  recordPageRead?: (profileId: string, htmlChars: number, textChars: number) => void;
  /** The site says the user is signed out: ask them to sign in. Resolves true once they have. */
  onSignedOut?: (siteUrl: string) => Promise<boolean>;
  /** Spaces out calls per site and pauses sites that push back. Off when not given (tests). */
  pacer?: Pacer;
  /** Calls a tool of another MCP server connected through AnyMCP. */
  upstream?: { call(server: string, tool: string, args: Record<string, unknown>): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> };
}

const signedOutNote = (site: string) =>
  `\n\nThe user is signed out of ${site}. Ask them to sign in there (call ask_user and wait), then try again.`;

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(err: unknown): ToolResult {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text }], isError: true };
}

export function untrusted(source: string, text: string): string {
  // Stop page text from closing the wrapper early.
  const safe = text.replace(/<\/untrusted-content>/gi, "</untrusted-content_>");
  return `<untrusted-content source="${source.replace(/"/g, "%22")}">\n${safe}\n</untrusted-content>`;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_BODY_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8");
}

/** Explains session values the browser couldn't find for a request. */
export function missingNote(missing: string[], profile: Profile): string | undefined {
  // "__xyz" fields are page plumbing that sites accept without; only mention the others.
  const names = missing.map((m) => m.replace(/^\w+:/, "")).filter((n) => !n.startsWith("__") && n !== "dpr");
  if (!names.length) return undefined;
  const shown = names.slice(0, 8).join(", ") + (names.length > 8 ? ", …" : "");
  return (
    `Note: AnyMCP couldn't find these session values in the browser, so they were left out: ${shown}. ` +
    `If the request failed, open ${profile.origins[0] ?? profile.name} in Chrome (signed in), use the site for a moment ` +
    `so AnyMCP can pick up its session, then try again.`
  );
}

export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  async callTool(id: string, rawArgs: unknown): Promise<ToolResult> {
    const found = this.deps.catalog.getTool(id);
    if (!found) {
      return errorResult(`No tool called "${id}". Use search_tools to find tool ids (they look like "site.com/tool_name").`);
    }
    const { profile } = found.entry;
    const { tool } = found;
    try {
      const args = checkArgs(tool.input, (rawArgs ?? {}) as Record<string, unknown>);
      await this.deps.approvals.check(profile, tool, args);
      const result = await this.run(profile, tool, args);
      this.deps.onToolResult?.(id, !result.isError);
      return result;
    } catch (err) {
      if (err instanceof TemplateError || err instanceof ApprovalError || err instanceof PaceError) return errorResult(err.message);
      this.deps.onToolResult?.(id, false);
      return errorResult(err);
    }
  }

  /** Asks the user to sign in when needed; true means try again. */
  private async signIn(profile: Profile, retried: boolean): Promise<boolean> {
    if (retried || !this.deps.onSignedOut) return false;
    return this.deps.onSignedOut(profile.origins[0] ?? `https://${profile.allowedHosts[0]}`).catch(() => false);
  }

  /** Waits for the site's pace before a call (see pacing.ts). */
  private async pace(url: string, profile: Profile, tool: Tool): Promise<void> {
    await this.deps.pacer?.before(url, {
      auth: effectiveAuth(profile, tool),
      acts: tool.mutates,
      profilePace: profile.pace,
      progress: callContext.getStore()?.progress,
    });
  }

  /** Notes how a call went; a message for the AI when the site got paused. */
  private paced(url: string, blocked: string | undefined, ok: boolean, retryAfter?: string): string | undefined {
    return this.deps.pacer?.after(url, { blocked, ok, retryAfterMs: retryAfterMs(retryAfter) });
  }

  private blockedResult(reason: string, note: string | undefined, profile: Profile): ToolResult {
    return {
      ...textResult(note ?? `${profile.name} seems to be limiting requests: ${reason}. Stop using it for now and tell the user.`),
      isError: true,
    };
  }

  private async run(profile: Profile, tool: Tool, args: Record<string, unknown>, retried = false): Promise<ToolResult> {
    const action = tool.action;
    const { browser } = this.deps;

    if (action.kind === "http") {
      const request = resolveHttpRequest(action, args);
      if (!hostAllowed(request.url, profile.allowedHosts)) {
        return errorResult(`Blocked: ${request.url} is not on this profile's allowed hosts.`);
      }
      await this.pace(request.url, profile, tool);
      let res: HttpResult;
      if (effectiveAuth(profile, tool) === "none") {
        res = await this.fetchPublic(request, profile.allowedHosts);
      } else {
        res = await browser.call("run_http", { origins: profile.origins, allowedHosts: profile.allowedHosts, request }, 45_000);
      }
      const blocked = looksBlocked(res);
      const okStatus = res.status >= 200 && res.status < 300;
      const paceNote = this.paced(request.url, blocked, okStatus || res.status === 401, res.retryAfter);
      if (blocked) return this.blockedResult(blocked, paceNote, profile);
      const signedOut = effectiveAuth(profile, tool) === "browser-session" && looksSignedOut(res);
      if (signedOut && (await this.signIn(profile, retried))) return this.run(profile, tool, args, true);
      const text = shapeResponse(res.body, res.contentType, action.response);
      this.deps.recordUsage?.(profile.id, res.body.length, text.length);
      const ok = res.status >= 200 && res.status < 300 && !signedOut;
      let out = (res.status >= 200 && res.status < 300 ? "" : `HTTP ${res.status} from ${res.url}\n`) + untrusted(res.url, text);
      if (signedOut) out += signedOutNote(profile.name);
      const note = res.missing?.length ? missingNote(res.missing, profile) : undefined;
      if (note) out += `\n\n${note}`;
      if (paceNote) out += `\n\n${paceNote}`;
      const result = textResult(out);
      if (!ok) result.isError = true;
      return result;
    }

    if (action.kind === "mcp") {
      if (!this.deps.upstream) return errorResult("MCP servers aren't available in this gateway.");
      const r = await this.deps.upstream.call(action.server, action.tool, args);
      const shaped = compactContent(r.content, action.maxChars);
      this.deps.recordUsage?.(profile.id, shaped.rawChars, shaped.returnedChars);
      return { content: shaped.content as ToolResult["content"], ...(r.isError ? { isError: true } : {}) };
    }

    if (action.kind === "page") {
      const resolved = resolvePageAction(action, args);
      if (!hostAllowed(resolved.url, profile.allowedHosts)) {
        return errorResult(`Blocked: ${resolved.url} is not on this profile's allowed hosts.`);
      }
      await this.pace(resolved.url, profile, tool);
      const page = await browser.call("run_page", { allowedHosts: profile.allowedHosts, action: resolved }, 60_000);
      const blocked = looksBlocked({ status: 200, url: page.url, body: page.text, page: true });
      const paceNote = this.paced(resolved.url, blocked, true);
      if (blocked) return this.blockedResult(blocked, paceNote, profile);
      if (isLoginUrl(page.url) && !isLoginUrl(resolved.url)) {
        if (await this.signIn(profile, retried)) return this.run(profile, tool, args, true);
        return { ...textResult(`The page sent us to a sign-in page (${page.url}).${signedOutNote(profile.name)}`), isError: true };
      }
      const text = truncate(page.text, resolved.maxChars);
      if (page.htmlChars) this.deps.recordPageRead?.(profile.id, page.htmlChars, text.length);
      return textResult(`Title: ${page.title}\nURL: ${page.url}\n\n${untrusted(page.url, text)}`);
    }

    if (action.kind === "form") {
      const resolved = resolveFormAction(action, args);
      if (!hostAllowed(resolved.page, profile.allowedHosts)) {
        return errorResult(`Blocked: ${resolved.page} is not on this profile's allowed hosts.`);
      }
      await this.pace(resolved.page, profile, tool);
      const page = await browser.call("run_form", { allowedHosts: profile.allowedHosts, action: resolved }, 60_000);
      const blocked = looksBlocked({ status: 200, url: page.url, body: page.text, page: true });
      const paceNote = this.paced(resolved.page, blocked, true);
      if (blocked) return this.blockedResult(blocked, paceNote, profile);
      if (isLoginUrl(page.url) && !isLoginUrl(resolved.page)) {
        if (await this.signIn(profile, retried)) return this.run(profile, tool, args, true);
        return { ...textResult(`The form sent us to a sign-in page (${page.url}).${signedOutNote(profile.name)}`), isError: true };
      }
      const text = truncate(page.text, resolved.maxChars);
      return textResult(`Title: ${page.title}\nURL: ${page.url}\n\n${untrusted(page.url, text)}`);
    }

    const page = resolveWebMcpPage(action, args);
    if (!hostAllowed(page, profile.allowedHosts)) {
      return errorResult(`Blocked: ${page} is not on this profile's allowed hosts.`);
    }
    await this.pace(page, profile, tool);
    const r = await browser.call("run_webmcp", { allowedHosts: profile.allowedHosts, page, tool: action.tool, args }, 60_000);
    this.paced(page, undefined, true);
    return textResult(untrusted(page, truncate(r.text, 20_000)));
  }

  private async fetchPublic(request: ReturnType<typeof resolveHttpRequest>, allowedHosts: string[]): Promise<HttpResult> {
    const doFetch = this.deps.fetch ?? fetch;
    const headers: Record<string, string> = {
      "user-agent": `AnyMCP/${this.deps.version} (+https://www.npmjs.com/package/anymcp-gateway)`,
      accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      ...request.headers,
    };
    let res: Response;
    try {
      res = await doFetch(request.url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const e = err as Error;
      const why = e.name === "TimeoutError" ? "timed out after 30s" : e.message;
      throw new Error(`Request to ${request.url} failed: ${why}`);
    }
    const finalUrl = res.url || request.url;
    if (!hostAllowed(finalUrl, allowedHosts)) {
      await res.body?.cancel();
      throw new Error(`Blocked: the site redirected to ${finalUrl}, which is not on this profile's allowed hosts.`);
    }
    return {
      status: res.status,
      url: finalUrl,
      contentType: res.headers.get("content-type") ?? "",
      body: await readCapped(res),
      retryAfter: res.headers.get("retry-after") ?? undefined,
    };
  }
}
