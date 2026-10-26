/**
 * Push inventory (server/internal/push/dispatcher.go; `workspace_slug` is added to every push in process()):
 *
 * | kind  | extra fields                                              |
 * |-------|-----------------------------------------------------------|
 * | inbox | item_id, type (every InboxItemType), issue_id?, comment_id? |
 * | chat  | session_id                                                |
 */
import { describe, expect, it } from "vitest";
import type { InboxItem, InboxItemType } from "@multica/core/types";
import { getInboxNavigationTarget } from "./inbox-display";
import { createOnceGate, parsePushData, pushTarget, shouldPresentInForeground } from "./push-routing";

describe("parsePushData", () => {
  it("reads data nested under body (server/expo convention)", () => {
    expect(parsePushData({ body: { kind: "chat", workspace_slug: "w", session_id: "s" } }))
      .toEqual({ kind: "chat", workspace_slug: "w", session_id: "s" });
  });
  it("reads top-level data", () => {
    expect(parsePushData({ kind: "inbox", workspace_slug: "w", item_id: "i" })?.kind).toBe("inbox");
  });
  it("rejects unknown or incomplete payloads", () => {
    expect(parsePushData({ kind: "bogus", workspace_slug: "w" })).toBeNull();
    expect(parsePushData({ kind: "inbox", item_id: "i" })).toBeNull();
    expect(parsePushData(null)).toBeNull();
  });
});

describe("pushTarget", () => {
  it("issue items open the issue with the comment highlighted", () => {
    expect(pushTarget({ kind: "inbox", workspace_slug: "w", item_id: "i", issue_id: "is", comment_id: "c" }))
      .toEqual({ pathname: "/[workspace]/issue/[id]", params: { workspace: "w", id: "is", highlight: "c" } });
  });
  it("autopilot items open the inbox detail", () => {
    expect(pushTarget({ kind: "inbox", workspace_slug: "w", item_id: "i", type: "autopilot_paused" }))
      .toEqual({ pathname: "/[workspace]/inbox/[id]", params: { workspace: "w", id: "i" } });
  });
  it("other issue-less items open the inbox tab", () => {
    expect(pushTarget({ kind: "inbox", workspace_slug: "w", item_id: "i", type: "quick_create_done" }))
      .toEqual({ pathname: "/[workspace]/inbox", params: { workspace: "w" } });
  });
  it("chat opens the chat tab on that session", () => {
    expect(pushTarget({ kind: "chat", workspace_slug: "w", session_id: "s" }))
      .toEqual({ pathname: "/[workspace]/chat", params: { workspace: "w" }, chatSessionId: "s" });
  });
});

const ALL_TYPES: InboxItemType[] = [
  "issue_assigned", "issue_subscribed", "unassigned", "assignee_changed", "status_changed",
  "priority_changed", "start_date_changed", "due_date_changed", "new_comment", "mentioned",
  "review_requested", "task_completed", "task_failed", "agent_blocked", "agent_completed",
  "reaction_added", "quick_create_done", "quick_create_failed", "quick_create_unconfirmed",
  "autopilot_paused", "autopilot_quota_exceeded", "children_done",
];

// What tapping the inbox row would do, reduced to the fields a push carries.
function rowTarget(type: InboxItemType, issue_id: string | null, comment_id?: string) {
  const item = { id: "i", type, issue_id, details: comment_id ? { comment_id } : {} } as unknown as InboxItem;
  const t = getInboxNavigationTarget(item, "b", "tok");
  if (!t) return { pathname: "/[workspace]/inbox", params: { workspace: "b" } };
  const { h: _h, ...params } = t.params as Record<string, unknown>;
  return { pathname: t.pathname, params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) };
}

describe("pushTarget parity with inbox row taps", () => {
  for (const type of ALL_TYPES) {
    it(`${type} with an issue matches the row tap`, () => {
      expect(pushTarget({ kind: "inbox", workspace_slug: "b", item_id: "i", type, issue_id: "is", comment_id: "c" }))
        .toEqual(rowTarget(type, "is", "c"));
    });
    it(`${type} without an issue matches the row tap`, () => {
      expect(pushTarget({ kind: "inbox", workspace_slug: "b", item_id: "i", type }))
        .toEqual(rowTarget(type, null));
    });
  }
  it("an unknown type without issue_id opens that workspace's inbox", () => {
    expect(pushTarget({ kind: "inbox", workspace_slug: "b", item_id: "i", type: "brand_new_type" }))
      .toEqual({ pathname: "/[workspace]/inbox", params: { workspace: "b" } });
  });
  it("an unknown type with issue_id opens the issue", () => {
    expect(pushTarget({ kind: "inbox", workspace_slug: "b", item_id: "i", type: "brand_new_type", issue_id: "is" }).pathname)
      .toBe("/[workspace]/issue/[id]");
  });
  it("routes with the payload's workspace, not the current one", () => {
    expect(pushTarget({ kind: "chat", workspace_slug: "b", session_id: "s" }).params.workspace).toBe("b");
  });
});

describe("shouldPresentInForeground", () => {
  const chat = { kind: "chat" as const, workspace_slug: "w", session_id: "s" };
  it("hides a chat push for the open chat", () =>
    expect(shouldPresentInForeground(chat, { activeChatSessionId: "s", onChatTab: true })).toBe(false));
  it("shows a chat push for another chat or when not on the chat tab", () => {
    expect(shouldPresentInForeground(chat, { activeChatSessionId: "x", onChatTab: true })).toBe(true);
    expect(shouldPresentInForeground(chat, { activeChatSessionId: "s", onChatTab: false })).toBe(true);
  });
  it("always shows inbox pushes and unknown payloads", () => {
    expect(shouldPresentInForeground({ kind: "inbox", workspace_slug: "w", item_id: "i" }, { activeChatSessionId: null, onChatTab: false })).toBe(true);
    expect(shouldPresentInForeground(null, { activeChatSessionId: null, onChatTab: true })).toBe(true);
  });
});

describe("createOnceGate", () => {
  it("lets each notification response through only once", () => {
    const once = createOnceGate();
    expect(once("n1")).toBe(true);
    expect(once("n1")).toBe(false); // remount of the workspace layout re-reads the same response
    expect(once("n2")).toBe(true);
  });
});
