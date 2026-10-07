import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

// api.ts refuses to load without a base URL; set it before the import runs.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://api.example.test";
});

// The real store pulls in expo-secure-store; the client only needs the slug.
vi.mock("@/data/workspace-store", () => ({ getCurrentSlug: () => null }));

describe("api.deleteComment", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // #8296: servers that keep a deleted comment's replies also route
  // /keep-replies; older servers do not, so a keep-replies delete that reaches
  // one fails instead of deleting the replies too.
  it.each([
    [{ keepReplies: true }, "https://api.example.test/api/comments/comment-1/keep-replies"],
    [{ keepReplies: false }, "https://api.example.test/api/comments/comment-1"],
    [undefined, "https://api.example.test/api/comments/comment-1"],
  ])("with %j sends DELETE %s", async (opts, url) => {
    await api.deleteComment("comment-1", opts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "DELETE" }));
  });
});

describe("api issue views + table rows", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("listIssues serialises object params as JSON", async () => {
    fetchMock.mockResolvedValue(json({ issues: [], total: 0 }));
    await api.listIssues({ properties: { "def-1": ["u-1"] } } as never);
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(JSON.parse(url.searchParams.get("properties")!)).toEqual({ "def-1": ["u-1"] });
  });

  it("listIssueViews GETs workspace views and tolerates a non-array body", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: "v1", name: "Needs me", query: {}, display: {} }]));
    const views = await api.listIssueViews({ scope_type: "workspace" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.test/api/issue-views?scope_type=workspace");
    expect(views.map((v) => v.name)).toEqual(["Needs me"]);

    fetchMock.mockResolvedValueOnce(json({ unexpected: true }));
    expect(await api.listIssueViews({ scope_type: "workspace" })).toEqual([]);
  });

  it("getIssueViewPreference falls back to empty prefs on garbage", async () => {
    fetchMock.mockResolvedValueOnce(json("nope"));
    const pref = await api.getIssueViewPreference({ scope_type: "workspace" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.example.test/api/issue-view-preferences?scope_type=workspace",
    );
    expect(pref.prefs).toEqual({ hidden: [], order: [] });
  });

  it("listIssueTableRows POSTs the request body", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ query_fingerprint: "f", group_key: null, parent_id: null, total: 0, rows: [], branch_total: 0, next_cursor: null }),
    );
    const req = {
      query: { scope: { kind: "workspace" as const }, filters: {}, sort: { field: "created_at" as const, direction: "desc" as const } },
      group: { kind: "none" as const },
      group_key: null,
      hierarchy: { enabled: false },
      parent_id: null,
      page: { limit: 100, cursor: null },
    };
    const res = await api.listIssueTableRows(req);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/issues/table/rows");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(req);
    expect(res.total).toBe(0);
  });
});

describe("api push devices", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers a device", async () => {
    const body = { platform: "ios" as const, token: "abc", bundle_id: "com.example.app", environment: "production" as const };
    await api.registerPushDevice(body);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/push/devices");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("unregisters a device by token", async () => {
    await api.unregisterPushDevice("a/b");
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/push/devices/a%2Fb");
    expect(init.method).toBe("DELETE");
  });
});
