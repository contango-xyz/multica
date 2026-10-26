// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDesktopFeedRelease,
  normalizeFeedBase,
  parseDesktopFeed,
} from "./desktop-feed";

const BASE = "https://srv.example.test/desktop/";

const YML = `version: 0.7.0-contango.4
files:
  - url: Multica-0.7.0-contango.4-arm64-mac.zip
    sha512: abc==
    size: 123
  - url: Multica-0.7.0-contango.4-arm64.dmg
    sha512: def==
    size: 456
path: Multica-0.7.0-contango.4-arm64-mac.zip
sha512: abc==
releaseDate: '2026-10-25T10:00:00.000Z'
`;

describe("normalizeFeedBase", () => {
  it("returns undefined when unset or blank", () => {
    expect(normalizeFeedBase(undefined)).toBeUndefined();
    expect(normalizeFeedBase("  ")).toBeUndefined();
  });
  it("adds a trailing slash and keeps http(s) only", () => {
    expect(normalizeFeedBase("https://a.test/desktop")).toBe(
      "https://a.test/desktop/",
    );
    expect(normalizeFeedBase("ftp://a.test/desktop/")).toBeUndefined();
    expect(normalizeFeedBase("not a url")).toBeUndefined();
  });
});

describe("parseDesktopFeed", () => {
  it("extracts the version and the dmg url under the feed base", () => {
    expect(parseDesktopFeed(YML, BASE)).toEqual({
      version: "0.7.0-contango.4",
      dmgUrl: `${BASE}Multica-0.7.0-contango.4-arm64.dmg`,
    });
  });

  it("accepts quoted values", () => {
    const yml = `version: '1.2.3'\nfiles:\n  - url: "A b.dmg"\n`;
    expect(parseDesktopFeed(yml, BASE)).toEqual({
      version: "1.2.3",
      dmgUrl: `${BASE}A%20b.dmg`,
    });
  });

  it.each([
    ["absolute", "https://evil.test/x.dmg"],
    ["scheme-relative", "//evil.test/x.dmg"],
    ["path traversal", "../x.dmg"],
    ["subpath", "sub/x.dmg"],
    ["backslash", "a\\\\x.dmg"],
  ])("rejects a %s dmg url", (_, url) => {
    expect(
      parseDesktopFeed(`version: 1.0.0\nfiles:\n  - url: ${url}\n`, BASE),
    ).toBeNull();
  });

  it("returns null without a version, without a dmg, or on garbage", () => {
    expect(parseDesktopFeed("files:\n  - url: a.dmg\n", BASE)).toBeNull();
    expect(
      parseDesktopFeed("version: 1.0.0\nfiles:\n  - url: a.zip\n", BASE),
    ).toBeNull();
    expect(parseDesktopFeed("<html>nope</html>", BASE)).toBeNull();
  });

  it("rejects a version with odd characters", () => {
    expect(
      parseDesktopFeed("version: <b>x\nfiles:\n  - url: a.dmg\n", BASE),
    ).toBeNull();
  });
});

describe("fetchDesktopFeedRelease", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches contango-mac.yml under the base and maps it to a release", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(YML));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchDesktopFeedRelease(BASE);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}contango-mac.yml`);
    expect(r?.version).toBe("0.7.0-contango.4");
    expect(r?.assets).toEqual({
      macArm64Dmg: `${BASE}Multica-0.7.0-contango.4-arm64.dmg`,
    });
  });

  it("returns null on HTTP errors, network errors and bad yml", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    expect(await fetchDesktopFeedRelease(BASE)).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await fetchDesktopFeedRelease(BASE)).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("junk")));
    expect(await fetchDesktopFeedRelease(BASE)).toBeNull();
  });
});
