const GROUP_PATH_SKIP = new Set([
  "feed",
  "joins",
  "discover",
  "notifications",
  "creates",
  "search",
]);

export function parseGroupUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "facebook.com" && host !== "web.facebook.com") {
    return null;
  }

  const match = parsed.pathname.match(/\/groups\/([^/]+)/i);
  if (!match) {
    return null;
  }

  const slug = decodeURIComponent(match[1]);
  if (!slug || GROUP_PATH_SKIP.has(slug.toLowerCase())) {
    return null;
  }

  const origin = parsed.hostname.includes("web.facebook.com")
    ? "https://web.facebook.com"
    : "https://www.facebook.com";

  return {
    slug,
    url: `${origin}/groups/${encodeURIComponent(slug)}/`,
  };
}

export function normalizeGroupUrl(url) {
  const parsed = parseGroupUrl(url);
  return parsed ? parsed.url : null;
}

export function sameGroup(urlA, urlB) {
  const a = parseGroupUrl(urlA);
  const b = parseGroupUrl(urlB);
  if (!a || !b) {
    return false;
  }
  return a.slug.toLowerCase() === b.slug.toLowerCase();
}

export function createGroupId(slug) {
  return `grp_${slug.toLowerCase()}`;
}
