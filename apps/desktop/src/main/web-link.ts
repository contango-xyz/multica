export type WebLinkDecision =
  | { kind: "route"; path: string }
  | { kind: "focus" }
  | { kind: "external" };

// Paths on our host that are not app routes: `/` (no destination), `/login`
// (pushing it through the navigation adapter logs the user out), and the
// server's `/desktop/*` downloads and `/api/*` endpoints.
function isFocusOnlyPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    /^\/(?:desktop|api)(?:\/|$)/.test(pathname)
  );
}

// Links a link router (e.g. Choosy) hands to the app. A URL on our host is
// never handed back to the OS: a router rule "our host -> Multica" would send
// it straight back here, forever. Such URLs either route in-app or only bring
// the app forward. Without runtime config our host is unknown, so every link
// only focuses. Everything on another host goes to the default browser.
export function decideWebLink(url: string, appUrl: string | null): WebLinkDecision {
  if (!appUrl) return { kind: "focus" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: "external" };
  }
  // Same host over http or https counts as ours: an http link would otherwise
  // fail an origin check and loop through the router.
  const ours =
    (u.protocol === "https:" || u.protocol === "http:") &&
    u.hostname === new URL(appUrl).hostname;
  if (!ours) return { kind: "external" };
  if (isFocusOnlyPath(u.pathname)) return { kind: "focus" };
  return { kind: "route", path: `${u.pathname}${u.search}${u.hash}` };
}
