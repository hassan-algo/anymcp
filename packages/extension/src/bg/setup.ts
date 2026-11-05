// The "Add a site" setup window. One at a time: opening it again focuses it.

const PAGE = "setup.html";
const WIDTH = 440;
const HEIGHT = 640;

function setupUrl(url?: string): string {
  return chrome.runtime.getURL(url ? `${PAGE}?url=${encodeURIComponent(url)}` : PAGE);
}

async function findSetupTab(): Promise<chrome.tabs.Tab | undefined> {
  const base = chrome.runtime.getURL(PAGE);
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
  for (const w of windows) {
    const t = w.tabs?.find((x) => x.url?.startsWith(base));
    if (t) return t;
  }
  return undefined;
}

export async function openSetupWindow(url?: string): Promise<void> {
  const existing = await findSetupTab();
  if (existing?.id !== undefined) {
    // Only reload it for a different site, so a recording in progress isn't interrupted.
    const current = new URL(existing.url!).searchParams.get("url") ?? "";
    if (url && url !== current) await chrome.tabs.update(existing.id, { url: setupUrl(url) });
    await chrome.windows.update(existing.windowId, { focused: true, drawAttention: true });
    return;
  }
  // Put it at the right edge of the browser window, so the site stays visible next to it.
  let left: number | undefined;
  let top: number | undefined;
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (w.left !== undefined && w.width !== undefined) left = Math.max(0, w.left + w.width - WIDTH - 16);
    if (w.top !== undefined) top = w.top + 80;
  } catch {
    // no normal window; let Chrome place it
  }
  await chrome.windows.create({ url: setupUrl(url), type: "popup", width: WIDTH, height: HEIGHT, left, top, focused: true });
}
