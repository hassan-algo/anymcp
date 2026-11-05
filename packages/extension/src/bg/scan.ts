// "Scan page": forms, WebMCP tools, an OpenAPI document and an official AnyMCP profile.

import { OPENAPI_PATHS } from "@anymcp/shared";
import type { ScanResult } from "../messages.js";
import { discoverApis, scanForms, webmcpList } from "../page/inpage.js";
import { ensureAccess, run } from "./tabs.js";

export async function scanTab(tabId: number): Promise<ScanResult> {
  const tab = await chrome.tabs.get(tabId);
  await ensureAccess(tab.url);
  const [forms, webmcp, discovered] = await Promise.all([
    run(tabId, scanForms, []),
    run(tabId, webmcpList, [], "MAIN").catch(() => ({ available: false, tools: [] })),
    run(tabId, discoverApis, [OPENAPI_PATHS]).catch(() => ({})),
  ]);
  return {
    url: tab.url ?? "",
    forms: forms.forms,
    skippedLoginForms: forms.skippedLoginForms,
    webmcp: webmcp.tools,
    ...discovered,
  };
}
