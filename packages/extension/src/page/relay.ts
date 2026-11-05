// Runs in the ISOLATED world next to recorder.ts and passes its captures to the background.

(() => {
  const g = globalThis as unknown as { __anymcpRelay?: boolean };
  if (g.__anymcpRelay) return;
  g.__anymcpRelay = true;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data as { source?: string; request?: unknown } | null;
    if (!d || d.source !== "anymcp-recorder" || typeof d.request !== "object" || d.request === null) return;
    try {
      chrome.runtime.sendMessage({ type: "captured", request: d.request }).catch(() => {});
    } catch {
      // The extension was reloaded; this page's relay is stale.
    }
  });
})();
