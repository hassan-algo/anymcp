export const VERSION = "0.1.0";

declare const __ANYMCP_BUILD__: number | undefined;
/** When this gateway was built (ms). Lets a newer gateway take over from an older one. */
export const BUILD = Number(process.env.ANYMCP_BUILD) || (typeof __ANYMCP_BUILD__ === "number" ? __ANYMCP_BUILD__ : 0);
