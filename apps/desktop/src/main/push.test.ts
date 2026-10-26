// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PUSH_CLICK_WINDOW_MS, RecentPush, chatSessionPath, routeForPushPayload } from "./push";

describe("routeForPushPayload", () => {
  it("routes inbox pushes to the issue in their own workspace", () => {
    expect(routeForPushPayload({ aps: {}, body: { kind: "inbox", workspace_slug: "b", item_id: "i1", issue_id: "is1" } }))
      .toEqual({ kind: "inbox", slug: "b", itemId: "i1", issueKey: "is1" });
  });
  it("falls back to the item id without an issue", () => {
    expect(routeForPushPayload({ body: { kind: "inbox", workspace_slug: "b", item_id: "i1" } }))
      .toEqual({ kind: "inbox", slug: "b", itemId: "i1", issueKey: "i1" });
  });
  it("routes chat pushes to the session", () => {
    expect(routeForPushPayload({ body: { kind: "chat", workspace_slug: "b", session_id: "s1" } }))
      .toEqual({ kind: "chat", slug: "b", sessionId: "s1" });
  });
  it.each([null, {}, { body: {} }, { body: { kind: "inbox", item_id: "i1" } }, { body: { kind: "x", workspace_slug: "b" } }])(
    "rejects %j", (v) => expect(routeForPushPayload(v)).toBeNull());
});

describe("chatSessionPath", () => {
  it("mirrors paths.workspace(slug).chatSession(id)", () => {
    expect(chatSessionPath("b", "s1")).toBe("/b/chat?session=s1");
  });
  it("encodes the slug and session id", () => {
    expect(chatSessionPath("a b", "s/1?x")).toBe("/a%20b/chat?session=s%2F1%3Fx");
  });
});

describe("RecentPush", () => {
  const route = { kind: "chat" as const, slug: "b", sessionId: "s1" };

  it("treats an activation right after a push as its click", () => {
    const recent = new RecentPush();
    recent.received(route, 1_000);
    expect(recent.takeOnActivate(1_000 + PUSH_CLICK_WINDOW_MS)).toEqual(route);
  });
  it("ignores activations after the window", () => {
    const recent = new RecentPush();
    recent.received(route, 1_000);
    expect(recent.takeOnActivate(1_001 + PUSH_CLICK_WINDOW_MS)).toBeNull();
  });
  it("opens a push at most once", () => {
    const recent = new RecentPush();
    recent.received(route, 1_000);
    recent.takeOnActivate(2_000);
    expect(recent.takeOnActivate(3_000)).toBeNull();
  });
  it("forgets a push with no route", () => {
    const recent = new RecentPush();
    recent.received(route, 1_000);
    recent.received(null, 2_000);
    expect(recent.takeOnActivate(3_000)).toBeNull();
  });
});
