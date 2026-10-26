// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  AASA_EXCLUDED_PATHS,
  AASA_PATHS,
  createPendingPath,
  mobilePathForWebPath,
  redirectLink,
} from "./universal-links";

describe("mobilePathForWebPath", () => {
  it.each([
    ["/acme/issues/MUL-1", "/acme/issue/MUL-1"],
    // Web comment deep link: `#comment-<id>` (parseCommentHighlightHash in packages/views).
    ["/acme/issues/MUL-1#comment-c1", "/acme/issue/MUL-1?highlight=c1"],
    ["/acme/issues/MUL-1#other", "/acme/issue/MUL-1"],
    ["/acme/inbox", "/acme/inbox"],
    ["/acme/inbox?issue=MUL-1", "/acme/issue/MUL-1"],
    ["/acme/inbox?view=archived", "/acme/inbox"],
    ["/acme/chat", "/acme/chat"],
    ["/acme/chat?session=s%201", "/acme/chat?session=s%201"],
    ["/acme/projects/p1", "/acme/project/p1"],
    ["/acme/my-issues", "/acme/my-issues"],
  ])("maps web %s to %s", (web, mobile) => {
    expect(mobilePathForWebPath(web)).toBe(mobile);
  });

  it("sends an unmapped workspace path to that workspace's inbox", () => {
    expect(mobilePathForWebPath("/acme/usage")).toBe("/acme/inbox");
    expect(mobilePathForWebPath("/acme/issues")).toBe("/acme/inbox");
    expect(mobilePathForWebPath("/acme")).toBe("/acme/inbox");
  });

  it.each(["/", "", "/login", "/desktop/x", "/api/x", "/auth/callback"])(
    "sends non-workspace path %j to the app root",
    (web) => {
      expect(mobilePathForWebPath(web)).toBe("/");
    },
  );

  it.each([
    "/acme/issue/MUL-1",
    "/acme/issue/MUL-1?highlight=c1",
    "/acme/project/p1",
    "/acme/inbox/item-1",
    "/acme/more/settings",
  ])("passes mobile-form path %s through unchanged", (path) => {
    expect(mobilePathForWebPath(path)).toBe(path);
  });
});

describe("redirectLink", () => {
  it("maps https links to the mobile path", () => {
    expect(redirectLink("https://example.com/acme/issues/MUL-1#comment-c1")).toBe(
      "/acme/issue/MUL-1?highlight=c1",
    );
    expect(redirectLink("https://example.com/acme/inbox?issue=MUL-2")).toBe("/acme/issue/MUL-2");
  });

  it("leaves app-scheme links and the launch URL unchanged", () => {
    expect(redirectLink("multica://acme/issue/MUL-1")).toBe("multica://acme/issue/MUL-1");
    expect(redirectLink("multica:///")).toBe("multica:///");
    expect(redirectLink("/acme/issue/MUL-1")).toBe("/acme/issue/MUL-1");
  });
});

describe("createPendingPath", () => {
  it("keeps the last linked screen until it is taken once", () => {
    const pending = createPendingPath();
    pending.remember("/acme/issue/MUL-1");
    pending.remember("/acme/issue/MUL-2");
    expect(pending.take()).toBe("/acme/issue/MUL-2");
    expect(pending.take()).toBeNull();
  });

  it("ignores the app root and can be cleared", () => {
    const pending = createPendingPath();
    pending.remember("/");
    expect(pending.take()).toBeNull();
    pending.remember("/acme/inbox");
    pending.clear();
    expect(pending.take()).toBeNull();
  });
});

describe("AASA paths", () => {
  it("covers every mapped web route and excludes non-app paths", () => {
    expect(AASA_PATHS).toEqual(["/*/issues/*", "/*/inbox", "/*/chat", "/*/projects/*", "/*/my-issues"]);
    expect(AASA_EXCLUDED_PATHS).toEqual(expect.arrayContaining(["/desktop/*", "/api/*", "/login"]));
  });
});
