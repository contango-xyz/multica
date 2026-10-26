// Links a link router (e.g. Choosy) hands to the app. Only our own server's
// URLs open inside; everything else goes back to the default browser.
export function appPathForWebUrl(url: string, appUrl: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== new URL(appUrl).origin) return null;
    const path = `${u.pathname}${u.search}${u.hash}`;
    return path === "/" ? null : path;
  } catch {
    return null;
  }
}
