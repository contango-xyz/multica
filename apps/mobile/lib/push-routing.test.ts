import { describe, expect, it } from "vitest";
import { parsePushData, pushTarget, shouldPresentInForeground } from "./push-routing";

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
