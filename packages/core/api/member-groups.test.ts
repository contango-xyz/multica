// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { MemberGroupListResponseSchema } from "./schemas";

const devops = {
  id: "g1",
  handle: "devops",
  name: "DevOps",
  description: "Infra and deploys",
  fallback_user_id: null,
  members: [
    { user_id: "u1", name: "Ana", email: "ana@example.test", handle: "ana", away: false, backup_user_id: null },
  ],
  on_duty: ["u1"],
  on_duty_via: "members",
  mention: "[@devops](mention://group/g1)",
  created_at: "2026-11-16T00:00:00Z",
  updated_at: "2026-11-16T00:00:00Z",
};

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MemberGroupListResponseSchema", () => {
  it("parses a full group", () => {
    expect(MemberGroupListResponseSchema.parse({ groups: [devops] }).groups[0]).toMatchObject({
      id: "g1",
      handle: "devops",
      members: [{ user_id: "u1", away: false }],
      on_duty: ["u1"],
    });
  });

  it("fills defaults and drops rows that cannot be mentioned", () => {
    const parsed = MemberGroupListResponseSchema.parse({
      groups: [
        { id: "g2", handle: "fe", members: [{ user_id: "u2" }, { name: "no id" }], on_duty: "nope" },
        { id: "g3" },
        "garbage",
      ],
    });
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]).toMatchObject({
      id: "g2",
      handle: "fe",
      name: "",
      description: "",
      fallback_user_id: null,
      members: [{ user_id: "u2", name: "", away: false, backup_user_id: null }],
      on_duty: [],
      on_duty_via: "members",
    });
  });

  it("treats a missing or malformed list as empty", () => {
    expect(MemberGroupListResponseSchema.parse({}).groups).toEqual([]);
    expect(MemberGroupListResponseSchema.parse({ groups: "x" }).groups).toEqual([]);
  });
});

describe("ApiClient.listMemberGroups", () => {
  it("requests /api/groups and returns the groups", async () => {
    const fetchMock = stubFetch({ groups: [devops] });
    const groups = await new ApiClient("https://api.example.test").listMemberGroups();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/groups");
    expect(groups.map((g) => g.handle)).toEqual(["devops"]);
  });

  it("falls back to no groups on a malformed response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(["not", "an", "object"]);
    await expect(new ApiClient("https://api.example.test").listMemberGroups()).resolves.toEqual([]);
  });

  it("treats a 404 from a server without groups as no groups", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ error: "not found" }, 404);
    await expect(new ApiClient("https://api.example.test").listMemberGroups()).resolves.toEqual([]);
  });

  it("still surfaces other failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ error: "boom" }, 500);
    await expect(new ApiClient("https://api.example.test").listMemberGroups()).rejects.toMatchObject({ status: 500 });
  });
});
