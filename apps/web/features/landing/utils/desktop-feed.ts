import type { LatestRelease } from "./github-release";

/**
 * Fork opt-in: the download page offers a desktop build published through an
 * electron-updater feed (`<base>/contango-mac.yml`) instead of upstream's
 * GitHub releases. Only the version and the .dmg name are read, and the .dmg
 * must be a bare file name resolved under the feed base, so a tampered feed
 * cannot redirect the download elsewhere.
 */

const FEED_FILE = "contango-mac.yml";
const REVALIDATE_SECONDS = 300;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const FILE_NAME_RE = /^[^/\\:?#%\s][^/\\:?#%]*\.dmg$/i;

/** Absolute http(s) feed base with a trailing slash, or undefined. */
export function normalizeFeedBase(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/*$/, "/");
  } catch {
    return undefined;
  }
}

function unquote(v: string): string {
  return v.replace(/^(['"])(.*)\1$/, "$2");
}

export function parseDesktopFeed(
  yml: string,
  base: string,
): { version: string; dmgUrl: string } | null {
  const version = unquote(/^version:[ \t]*(.+?)[ \t]*$/m.exec(yml)?.[1] ?? "");
  if (!VERSION_RE.test(version)) return null;

  for (const m of yml.matchAll(/^[ \t]*(?:-[ \t]+)?url:[ \t]*(.+?)[ \t]*$/gm)) {
    const name = unquote(m[1] ?? "");
    if (name.toLowerCase().endsWith(".dmg") && !FILE_NAME_RE.test(name)) {
      return null;
    }
    if (FILE_NAME_RE.test(name) && name !== "." && name !== "..") {
      return { version, dmgUrl: new URL(encodeURIComponent(name), base).toString() };
    }
  }
  return null;
}

export async function fetchDesktopFeedRelease(
  base: string,
): Promise<LatestRelease | null> {
  try {
    const res = await fetch(`${base}${FEED_FILE}`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) throw new Error(`desktop feed responded ${res.status}`);
    const parsed = parseDesktopFeed(await res.text(), base);
    if (!parsed) throw new Error("desktop feed has no usable version/dmg");
    return {
      version: parsed.version,
      publishedAt: null,
      htmlUrl: null,
      assets: { macArm64Dmg: parsed.dmgUrl },
    };
  } catch (err) {
    console.warn("[download] desktop feed unavailable, using upstream:", err);
    return null;
  }
}
