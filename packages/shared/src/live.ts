// Where to find {$live:name} values when the page hasn't sent them in a request yet.
// The extension tries, in order: the value the page last sent, these patterns in the page's
// HTML/inline scripts, a hidden <input name=…>, a <meta name=…>, then a generic `"name":"value"`.

/** Regex sources (one capture group) per lowercase name. Used against the page's HTML. */
export const LIVE_PATTERNS: Record<string, string[]> = {
  // Facebook, Instagram, Threads, Messenger
  fb_dtsg: [String.raw`"DTSGInitialData",\[\],\{"token":"([^"]+)"`, String.raw`"DTSGInitData",\[\],\{"token":"([^"]+)"`, String.raw`"dtsg":\{"token":"([^"]+)"`, String.raw`name="fb_dtsg" value="([^"]+)"`],
  lsd: [String.raw`"LSD",\[\],\{"token":"([^"]+)"`, String.raw`name="lsd" value="([^"]+)"`],
  "x-fb-lsd": [String.raw`"LSD",\[\],\{"token":"([^"]+)"`],
  "x-ig-app-id": [String.raw`"X-IG-App-ID":"(\d+)"`, String.raw`"appId":"(\d+)"`, String.raw`"APP_ID":"(\d+)"`],
  "x-asbd-id": [String.raw`"ASBD_ID":"?(\d+)"?`],
  av: [String.raw`"actorID":"(\d+)"`, String.raw`"ACCOUNT_ID":"(\d+)"`],
  __user: [String.raw`"USER_ID":"(\d+)"`],
  __rev: [String.raw`"server_revision":(\d+)`, String.raw`"__spin_r":(\d+)`],
  __spin_r: [String.raw`"__spin_r":(\d+)`],
  __spin_b: [String.raw`"__spin_b":"([^"]+)"`],
  __spin_t: [String.raw`"__spin_t":(\d+)`],
  __hsi: [String.raw`"hsi":"(\d+)"`],
  // Common CSRF conventions
  "x-csrf-token": [String.raw`<meta name="csrf-token" content="([^"]+)"`],
  "x-csrftoken": [String.raw`"csrf_token":"([^"]+)"`],
  authenticity_token: [String.raw`name="authenticity_token" value="([^"]+)"`],
  csrfmiddlewaretoken: [String.raw`name="csrfmiddlewaretoken" value="([^"]+)"`],
  __requestverificationtoken: [String.raw`name="__RequestVerificationToken" (?:type="hidden" )?value="([^"]+)"`],
};

/** Values computed from other values. */
export function deriveLiveValue(name: string, known: Record<string, string | undefined>): string | undefined {
  if (name === "jazoest") {
    // Facebook's jazoest is "2" + the sum of the fb_dtsg character codes.
    const dtsg = known["fb_dtsg"];
    if (!dtsg) return undefined;
    let sum = 0;
    for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
    return `2${sum}`;
  }
  return undefined;
}

/** Generic fallback: `"name":"value"` or `name: "value"` in an inline script. */
export function genericLivePattern(name: string): string {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String.raw`["']?${n}["']?\s*[:=]\s*["']([^"'\\]{1,2000})["']`;
}
