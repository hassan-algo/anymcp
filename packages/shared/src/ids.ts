// Tool identifiers.
//
// A tool id is "<profileId>/<toolName>", e.g. "news.ycombinator.com/search_stories".
// MCP tool names only allow [A-Za-z0-9_-]{1,64}, so pinned tools get a sanitized name.

export function toolId(profileId: string, toolName: string): string {
  return `${profileId}/${toolName}`;
}

export function parseToolId(id: string): { profileId: string; toolName: string } | undefined {
  const i = id.lastIndexOf("/");
  if (i <= 0 || i === id.length - 1) return undefined;
  return { profileId: id.slice(0, i), toolName: id.slice(i + 1) };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Name used when a tool is pinned as a regular MCP tool, e.g. "news_ycombinator_com__search_stories". */
export function pinnedToolName(profileId: string, toolName: string): string {
  const site = profileId.replace(/^www\./, "").replace(/[^A-Za-z0-9]+/g, "_");
  const name = `${site}__${toolName}`;
  if (name.length <= 64) return name;
  const suffix = `_${hash(name)}`;
  return name.slice(0, 64 - suffix.length) + suffix;
}

/** Does this profile belong to the page at `url`? Matches exact origins and their subdomains. */
export function originMatches(origins: readonly string[], url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  return origins.some((o) => {
    try {
      const oh = new URL(o).host.replace(/^www\./, "");
      return host === oh || host.endsWith(`.${oh}`) || host === `www.${oh}`;
    } catch {
      return false;
    }
  });
}
