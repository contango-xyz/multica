// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@multica/core/types";
import { ApiError } from "@/data/api";
import {
  buildSmartList,
  buildSmartRows,
  cardIdFromUrl,
  signalReplyError,
  signalSince,
} from "./smart-inbox";

// ApiError lives in data/api, which refuses to load without a base URL.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://api.example.test";
});
vi.mock("@/data/workspace-store", () => ({ getCurrentSlug: () => null }));

const NOW = Date.parse("2026-11-07T12:00:00Z");

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "me",
    actor_type: "agent",
    actor_id: "agent-1",
    type: "new_comment",
    severity: "info",
    issue_id: "issue-1",
    title: "Issue title",
    body: null,
    issue_status: null,
    read: true,
    archived: false,
    created_at: "2026-11-07T11:00:00Z",
    details: null,
    ...overrides,
  };
}

function signal(
  id: string,
  group: string,
  overrides: Partial<InboxItem> = {},
  rank: Record<string, unknown> = { priority: "none", blocks: 0, since: "2026-11-07T11:00:00Z" },
): InboxItem {
  return item({
    id,
    type: "signal",
    actor_type: "system",
    actor_id: null,
    severity: "action_required",
    title: `Signal ${id}`,
    details: { key: id, group, summary: `summary ${id}`, rank } as unknown as Record<string, string>,
    ...overrides,
  });
}

describe("buildSmartRows", () => {
  it("folds a card's other entries into its action signal", () => {
    const sig = signal("sig", "decision", { read: true, created_at: "2026-11-07T10:00:00Z" });
    const mention = item({
      id: "mention",
      type: "mentioned",
      actor_id: "agent-7",
      read: false,
      details: { comment_id: "c-9" },
    });
    const other = item({ id: "other", issue_id: "issue-2" });

    const rows = buildSmartRows([sig, mention, other]);

    expect(rows.map((r) => r.id)).toEqual(["sig", "other"]);
    expect(rows[0]).toMatchObject({
      type: "signal",
      actor_type: "agent",
      actor_id: "agent-7",
      read: false,
      details: expect.objectContaining({ comment_id: "c-9", group: "decision" }),
    });
  });

  it("does not fold into fyi signals or signals without an issue", () => {
    const fyi = signal("fyi", "fyi");
    const comment = item({ id: "comment" });
    const loose = signal("loose", "alert", { issue_id: null });

    const rows = buildSmartRows([fyi, comment, loose]);

    expect(rows.map((r) => r.id).sort()).toEqual(["comment", "fyi", "loose"]);
  });

  it("drops archived entries", () => {
    expect(buildSmartRows([signal("s", "merge", { archived: true })])).toEqual([]);
  });
});

describe("buildSmartList", () => {
  it("orders sections by their top entry's score, FYI last, and ranks within", () => {
    const merge = signal("merge", "merge", { issue_id: "i-1" }, { priority: "urgent", blocks: 2, since: "2026-11-07T06:00:00Z" });
    const decisionLow = signal("d-low", "decision", { issue_id: "i-2" }, { priority: "low", blocks: 0, since: "2026-11-07T11:00:00Z" });
    const decisionHigh = signal("d-high", "decision", { issue_id: "i-3" }, { priority: "high", blocks: 0, since: "2026-11-07T08:00:00Z" });
    const mention = item({ id: "mention", type: "mentioned", issue_id: "i-4", created_at: "2026-11-07T11:30:00Z" });
    const status = item({ id: "status", type: "status_changed", issue_id: "i-5" });

    const sections = buildSmartList([status, decisionLow, mention, merge, decisionHigh], NOW);

    expect(sections.map((s) => s.id)).toEqual(["merge", "decision", "mentions", "fyi"]);
    expect(sections[1]!.data.map((e) => e.item.id)).toEqual(["d-high", "d-low"]);
    expect(sections[3]!.data.map((e) => e.item.id)).toEqual(["status"]);
  });
});

describe("signalSince", () => {
  it("is the wait for a signal and the row time otherwise", () => {
    expect(signalSince(signal("s", "merge", {}, { since: "2026-11-01T00:00:00Z" }))).toBe("2026-11-01T00:00:00Z");
    expect(signalSince(item({ created_at: "2026-11-02T00:00:00Z" }))).toBe("2026-11-02T00:00:00Z");
  });
});

describe("cardIdFromUrl", () => {
  it.each([
    ["https://multica.int.contangov3.com/acme/issues/CTG-123", "CTG-123"],
    ["https://multica.int.contangov3.com/acme/issue/CTG-1", "CTG-1"],
    ["https://multica.int.contangov3.com/acme/issues/CTG-7?tab=activity#comment-1", "CTG-7"],
    [
      "https://multica.ai/acme/issues/0b7e0f3c-1d2a-4e5b-8c9d-0123456789ab",
      "0b7e0f3c-1d2a-4e5b-8c9d-0123456789ab",
    ],
  ])("opens %s in-app", (url, id) => {
    expect(cardIdFromUrl(url, "acme")).toBe(id);
  });

  it.each([
    "https://github.com/contango-xyz/multica/issues/12",
    "https://github.com/acme/issues/12",
    "https://multica.int.contangov3.com/other-ws/issues/CTG-1",
    "https://multica.int.contangov3.com/acme/issues/CTG-1/edit",
    "https://multica.int.contangov3.com/acme/projects/CTG-1",
    "mailto:me@example.com",
    "not a url",
  ])("leaves %s to the browser", (url) => {
    expect(cardIdFromUrl(url, "acme")).toBeNull();
  });

  it("needs a workspace", () => {
    expect(cardIdFromUrl("https://x.test/acme/issues/CTG-1", null)).toBeNull();
  });
});

describe("signalReplyError", () => {
  it("explains a 404 in its own words", () => {
    expect(signalReplyError(new ApiError("404 Not Found", 404, { error: "inbox item not found" }))).toEqual({
      key: "smart.reply.gone",
    });
  });

  it("shows the server's reason for a 409", () => {
    expect(
      signalReplyError(new ApiError("409 Conflict", 409, { error: "this reply is no longer offered" })),
    ).toEqual({ message: "this reply is no longer offered" });
    expect(signalReplyError(new ApiError("409 Conflict", 409))).toEqual({ key: "smart.reply.changed" });
  });

  it("falls back to the server's reason, then the generic text", () => {
    expect(signalReplyError(new ApiError("403 Forbidden", 403, { error: "forbidden" }))).toEqual({
      message: "forbidden",
    });
    expect(signalReplyError(new ApiError("Request timed out", 0))).toEqual({ key: "smart.reply.failed" });
    expect(signalReplyError(undefined)).toEqual({ key: "smart.reply.failed" });
  });
});
