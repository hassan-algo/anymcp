// Small popup windows that ask the user something and wait: approvals and questions.
// Each request gets an id; its page fetches the request by id and answers by id.
// Closing the window or the timeout resolves with the fallback answer.

interface Pending<Req, Res> {
  request: Req;
  resolve: (r: Res) => void;
  windowId?: number;
  timer: ReturnType<typeof setTimeout>;
}

export class PopupRequests<Req, Res> {
  private readonly pending = new Map<string, Pending<Req, Res>>();

  constructor(
    private readonly page: string,
    private readonly size: { width: number; height: number },
    private readonly fallback: Res,
  ) {
    chrome.windows.onRemoved.addListener((windowId) => {
      for (const [id, p] of this.pending) if (p.windowId === windowId) this.finish(id, this.fallback);
    });
  }

  /** Opens the popup. `near` = a window to place it beside (default: the last focused one). */
  open(request: Req, opts: { timeoutMs: number; near?: number }): Promise<Res> {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const entry: Pending<Req, Res> = { request, resolve, timer: setTimeout(() => this.finish(id, this.fallback), opts.timeoutMs) };
      this.pending.set(id, entry);
      void (async () => {
        const pos = await this.position(opts.near);
        const win = await chrome.windows.create({
          url: chrome.runtime.getURL(`${this.page}?id=${id}`),
          type: "popup",
          width: this.size.width,
          height: this.size.height,
          ...pos,
          focused: true,
        });
        if (!this.pending.has(id)) {
          if (win?.id !== undefined) chrome.windows.remove(win.id).catch(() => {});
          return;
        }
        entry.windowId = win?.id;
      })().catch(() => this.finish(id, this.fallback));
    });
  }

  get(id: string): Req | null {
    return this.pending.get(id)?.request ?? null;
  }

  answer(id: string, res: Res): void {
    this.finish(id, res);
  }

  private finish(id: string, res: Res): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (p.windowId !== undefined) chrome.windows.remove(p.windowId).catch(() => {});
    p.resolve(res);
  }

  /** Inside the right edge of the browser window, so the page stays visible beside it. */
  private async position(near?: number): Promise<{ left?: number; top?: number }> {
    try {
      const w = near !== undefined ? await chrome.windows.get(near) : await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      if (w.left === undefined || w.width === undefined) return {};
      return { left: Math.max(0, w.left + w.width - this.size.width - 16), top: (w.top ?? 0) + 80 };
    } catch {
      return {};
    }
  }
}
