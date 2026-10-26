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
const FETCH_TIMEOUT_MS = 5000;
const MAX_FEED_BYTES = 64 * 1024;
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
  rawYml: string,
  base: string,
): { version: string; dmgUrl: string } | null {
  const yml = rawYml.replace(/\r\n?/g, "\n");
  const version = unquote(/^version:[ \t]*(.+?)[ \t]*$/m.exec(yml)?.[1] ?? "");
  if (!VERSION_RE.test(version)) return null;

  const dmgs: string[] = [];
  for (const m of yml.matchAll(/^[ \t]*(?:-[ \t]+)?url:[ \t]*(.+?)[ \t]*$/gm)) {
    const name = unquote(m[1] ?? "");
    if (!name.toLowerCase().endsWith(".dmg")) continue;
    if (!FILE_NAME_RE.test(name)) return null;
    dmgs.push(name);
  }
  // This page offers Apple Silicon: prefer the arm64 build, accept a lone
  // dmg, and treat anything ambiguous as unusable (upstream fallback).
  const arm = dmgs.filter((n) => /arm64/i.test(n));
  const pick = arm.length === 1 ? arm[0] : dmgs.length === 1 ? dmgs[0] : undefined;
  if (!pick) return null;
  return { version, dmgUrl: new URL(encodeURIComponent(pick), base).toString() };
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_FEED_BYTES) throw new Error("desktop feed too large");
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) throw new Error("desktop feed too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new Error("desktop feed too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function fetchDesktopFeedRelease(
  base: string,
): Promise<LatestRelease | null> {
  try {
    const res = await fetch(`${base}${FEED_FILE}`, {
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`desktop feed responded ${res.status}`);
    const parsed = parseDesktopFeed(await readCapped(res), base);
    if (!parsed) throw new Error("desktop feed has no usable version/dmg");
    return {
      version: parsed.version,
      publishedAt: null,
      htmlUrl: null,
      forkOnly: true,
      assets: { macArm64Dmg: parsed.dmgUrl },
    };
  } catch (err) {
    console.warn("[download] desktop feed unavailable, using upstream:", err);
    return null;
  }
}
