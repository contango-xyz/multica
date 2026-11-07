import { describe, expect, it } from "vitest";
import { signalDetails } from "@multica/core/inbox/smart";
import { InboxListSchema, InboxUnreadSummarySchema } from "./schemas";

/**
 * Tests for mobile's CLIENT-SIDE parsing of GET /api/inbox.
 *
 * Scope, stated precisely because the name of this file used to overclaim:
 * these are hand-written fixtures run against `InboxListSchema`. They pin how
 * this client REACTS to a given payload. They cannot fail when the Go server
 * starts sending something new — nothing here executes server code.
 *
 * `details` values are not validated (like web's InboxItemListSchema): the
 * contango smart inbox's `signal` rows carry arrays and objects there, and a
 * string-only record used to fail the whole array on the first signal, so a
 * flagged user's mobile inbox rendered empty. Signal details are read through
 * core's `signalDetails`, which validates them per field.
 */
describe("inbox list schema", () => {
  it("parses a row shaped like the documented server payload", () => {
    const serverRow = {
      id: "inbox-1",
      workspace_id: "ws-1",
      recipient_type: "member",
      recipient_id: "user-1",
      type: "status_changed",
      severity: "info",
      issue_id: "issue-1",
      title: "P0: delegated subscription rule",
      body: "",
      actor_type: "agent",
      actor_id: "agent-1",
      read: false,
      archived: false,
      created_at: "2026-07-30T00:00:00Z",
      details: { from: "in_progress", to: "in_review" },
    };

    const parsed = InboxListSchema.safeParse([serverRow]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[0]?.type).toBe("status_changed");
    expect(parsed.success && parsed.data[0]?.details?.to).toBe("in_review");
  });

  it("keeps a smart-inbox signal and its structured details next to other rows", () => {
    const mention = {
      id: "inbox-2",
      recipient_type: "member",
      type: "mentioned",
      issue_id: "issue-1",
      details: { comment_id: "c-1" },
    };
    const signal = {
      id: "inbox-3",
      workspace_id: "ws-1",
      recipient_type: "member",
      recipient_id: "user-1",
      actor_type: "system",
      actor_id: null,
      type: "signal",
      severity: "action_required",
      issue_id: "issue-1",
      title: "Approve plan for CTG-12",
      body: "The plan is in the card.",
      read: false,
      archived: false,
      created_at: "2026-11-07T08:00:00Z",
      details: {
        key: "needs-human:CTG-12:c-1",
        group: "decision",
        summary: "CTG-12 · waiting 6 h",
        actions: [{ label: "Open card", url: "https://multica.example/acme/issues/CTG-12" }],
        replies: [{ label: "Approve: agree", content: "agree", parent_comment_id: "c-1" }],
        rank: { priority: "high", blocks: 3, since: "2026-11-07T02:00:00Z" },
      },
    };

    const parsed = InboxListSchema.safeParse([mention, signal]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[1]?.type).toBe("signal");
    expect(signalDetails(parsed.data[1]!)).toEqual({
      key: "needs-human:CTG-12:c-1",
      group: "decision",
      summary: "CTG-12 · waiting 6 h",
      actions: [{ label: "Open card", url: "https://multica.example/acme/issues/CTG-12" }],
      replies: [{ index: 0, label: "Approve: agree", content: "agree", parent_comment_id: "c-1" }],
      rank: { priority: "high", blocks: 3, since: "2026-11-07T02:00:00Z" },
    });
  });

  it("tolerates a numeric details value instead of dropping the whole list", () => {
    const good = {
      id: "inbox-4",
      recipient_type: "member",
      type: "status_changed",
      details: { from: "todo", to: "in_review" },
    };
    const odd = {
      id: "inbox-5",
      recipient_type: "member",
      type: "children_done",
      details: { child_count: 3 },
    };

    const parsed = InboxListSchema.safeParse([good, odd]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.map((r) => r.id)).toEqual(["inbox-4", "inbox-5"]);
  });

  it("reads malformed details (not an object) as null rather than failing the list", () => {
    const parsed = InboxListSchema.safeParse([
      { id: "inbox-6", recipient_type: "member", type: "signal", details: "oops" },
    ]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[0]?.details).toBeNull();
  });

  it("renders an unknown server type instead of dropping the row", () => {
    // Mirrors the root CLAUDE.md API-compatibility rule and mobile's own
    // "render every inbox type, never silently drop a category" parity rule: a
    // type this build has never heard of must still parse.
    const future = {
      id: "inbox-5",
      recipient_type: "member",
      type: "some_future_type",
      details: { anything: "still a string" },
    };

    const parsed = InboxListSchema.safeParse([future]);
    expect(parsed.success).toBe(true);
  });
});

/**
 * GET /api/inbox/unread-summary — the source of the inbox tab badge.
 *
 * Blast radius differs from the list above: `getInboxUnreadSummary` falls back
 * to an empty array, which reads as "nothing unread" and simply hides the
 * badge. A wrong number would be worse than no number, so the schema stays
 * strict about the shape and lenient only about extra fields.
 */
describe("inbox unread summary schema", () => {
  it("parses the documented server payload", () => {
    const parsed = InboxUnreadSummarySchema.safeParse([
      { workspace_id: "ws-1", count: 3 },
      { workspace_id: "ws-2", count: 1 },
    ]);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[1]?.count).toBe(1);
  });

  it("passes through a field this client does not know yet", () => {
    const parsed = InboxUnreadSummarySchema.safeParse([
      { workspace_id: "ws-1", count: 3, unread_mentions: 2 },
    ]);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[0]?.count).toBe(3);
  });

  it("reads a non-numeric count as zero rather than failing the list", () => {
    // One malformed row must not blank every other workspace's count.
    const parsed = InboxUnreadSummarySchema.safeParse([
      { workspace_id: "ws-1", count: "many" },
      { workspace_id: "ws-2", count: 5 },
    ]);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[0]?.count).toBe(0);
    expect(parsed.success && parsed.data[1]?.count).toBe(5);
  });

  it("rejects a row with no workspace id", () => {
    // Without an id the entry can never be matched to a workspace, so it would
    // silently contribute nothing — fail loudly into the empty fallback.
    expect(
      InboxUnreadSummarySchema.safeParse([{ count: 3 }]).success,
    ).toBe(false);
  });
});
