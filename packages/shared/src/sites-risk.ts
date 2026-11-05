// Which sites need extra care: social networks and others known to restrict accounts that act
// automated. Used by the gateway's pacing and by the extension's warnings.

/** Sites known to restrict accounts that act automated. */
export const STRICT_SITES = new Set([
  "instagram.com", "facebook.com", "messenger.com", "threads.net", "threads.com", "whatsapp.com",
  "x.com", "twitter.com", "linkedin.com", "tiktok.com", "reddit.com", "pinterest.com", "snapchat.com",
  "tumblr.com", "discord.com", "quora.com", "youtube.com", "google.com", "bing.com", "ebay.com",
  "craigslist.org", "tinder.com", "bumble.com", "hinge.co", "airbnb.com", "booking.com",
  "ticketmaster.com", "indeed.com", "glassdoor.com", "upwork.com", "fiverr.com", "nextdoor.com",
  "vk.com", "telegram.org", "bsky.app", "twitch.tv", "medium.com", "substack.com",
]);
/** Brands with a domain per country (amazon.de, google.co.uk…). */
const STRICT_BRANDS = /^(amazon|google|ebay|facebook|instagram|linkedin|booking)\./;

/** The site a URL belongs to: "www.instagram.com" and "i.instagram.com" are both "instagram.com". */
export function siteKey(urlOrHost: string): string {
  let host = urlOrHost;
  try {
    if (/^[a-z]+:\/\//i.test(urlOrHost)) host = new URL(urlOrHost).hostname;
  } catch {
    // keep as given
  }
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  // co.uk, com.au, org.br …: keep one more label.
  const second = labels[labels.length - 2]!;
  const take = labels[labels.length - 1]!.length === 2 && /^(co|com|net|org|gov|ac|edu|ne|or)$/.test(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

export function isStrictSite(site: string): boolean {
  return STRICT_SITES.has(site) || STRICT_BRANDS.test(site);
}

