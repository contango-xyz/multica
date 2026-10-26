/**
 * Universal links: a link to our web app (Slack, GitHub, Mail) opens the
 * matching mobile screen. Web routes live in
 * apps/web/app/[workspaceSlug]/(dashboard)/, mobile routes in
 * app/(app)/[workspace]/; the two differ, so incoming web paths are mapped.
 * A web path the app has no screen for lands on that workspace's inbox.
 */
import { isReservedSlug } from "@multica/core/paths/reserved-slugs";

/** Web path patterns handled in the app (Apple `components` "/" format). */
export const AASA_PATHS = ["/*/issues/*", "/*/inbox", "/*/chat", "/*/projects/*", "/*/my-issues"];

/**
 * Never opened in the app. `/desktop/*` is the fork's desktop build feed
 * (docs/contango/desktop-release.md), served outside the web app, so it is
 * not a reserved workspace slug.
 */
export const AASA_EXCLUDED_PATHS = ["/desktop/*", "/api/*", "/login", "/auth/*"];

const NON_WORKSPACE_PREFIXES = new Set(["desktop"]);

/** First segments under a workspace that are already mobile routes. */
const MOBILE_ROUTES = new Set(["issue", "project", "inbox", "more", "search"]);

function splitLink(link: string): { path: string; query: string; hash: string } {
  let rest = link.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  const hashAt = rest.indexOf("#");
  const hash = hashAt >= 0 ? rest.slice(hashAt) : "";
  if (hashAt >= 0) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : "";
  const path = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
  return { path, query, hash };
}

function queryParam(query: string, name: string): string | undefined {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    if (key !== name) continue;
    try {
      const value = decodeURIComponent((eq >= 0 ? pair.slice(eq + 1) : "").replace(/\+/g, " "));
      return value || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function mobilePathForWebPath(pathWithQuery: string): string {
  const { path, query, hash } = splitLink(pathWithQuery);
  const [workspace, page, id] = path.split("/").filter(Boolean);
  if (!workspace || isReservedSlug(workspace) || NON_WORKSPACE_PREFIXES.has(workspace)) return "/";
  const ws = `/${workspace}`;

  if (page === "issues" && id) {
    // Same anchor the web reads: parseCommentHighlightHash in packages/views.
    const comment = /^#comment-([A-Za-z0-9_-]+)$/.exec(hash)?.[1];
    return `${ws}/issue/${id}${comment ? `?highlight=${comment}` : ""}`;
  }
  if (page === "inbox" && !id) {
    // `?issue=` is the web inbox selection; the web falls back to the issue page.
    const issue = queryParam(query, "issue");
    return issue ? `${ws}/issue/${encodeURIComponent(issue)}` : `${ws}/inbox`;
  }
  if (page === "chat" && !id) {
    const session = queryParam(query, "session");
    return session ? `${ws}/chat?session=${encodeURIComponent(session)}` : `${ws}/chat`;
  }
  if (page === "projects" && id) return `${ws}/project/${id}`;
  if (page === "my-issues" && !id) return `${ws}/my-issues`;
  if (page && MOBILE_ROUTES.has(page)) return query ? `${path}?${query}` : path;
  return `${ws}/inbox`;
}

/**
 * Expo Router hands `+native-intent` the full incoming URL. Universal links
 * (https) are mapped; app-scheme URLs, including the plain launch URL, are
 * already in mobile form.
 */
export function redirectLink(url: string): string {
  return /^https:\/\//i.test(url) ? mobilePathForWebPath(url) : url;
}

/**
 * The screen a link asked for, kept while the user signs in: the auth gate
 * sends a logged-out start to /login, and verify replays it afterwards.
 */
export function createPendingPath() {
  let pending: string | null = null;
  return {
    remember(path: string) {
      pending = path === "/" ? null : path;
    },
    take(): string | null {
      const path = pending;
      pending = null;
      return path;
    },
    clear() {
      pending = null;
    },
  };
}

export const pendingLink = createPendingPath();
