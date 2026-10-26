// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handoffUrl,
  readOpenInDesktop,
  shouldHandOff,
  writeOpenInDesktop,
} from "./desktop-handoff";

const KEY = "multica:open-links-in-desktop";

function stubStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handoffUrl", () => {
  it("encodes the path, search and hash into a multica://open link", () => {
    expect(handoffUrl("/acme/issues/MUL-1", "?tab=a&b=c", "#comment-1")).toBe(
      "multica://open?path=%2Facme%2Fissues%2FMUL-1%3Ftab%3Da%26b%3Dc%23comment-1",
    );
  });

  it("works without search or hash", () => {
    expect(handoffUrl("/acme/inbox", "", "")).toBe(
      "multica://open?path=%2Facme%2Finbox",
    );
  });
});

describe("shouldHandOff", () => {
  it.each([
    [true, "navigate", false, true],
    [false, "navigate", false, false],
    [true, "reload", false, false],
    [true, "back_forward", false, false],
    [true, "prerender", false, false],
    [true, undefined, false, false],
    [true, "navigate", true, false],
  ] as const)(
    "enabled=%s navigationType=%s alreadyHandled=%s -> %s",
    (enabled, navigationType, alreadyHandled, expected) => {
      expect(shouldHandOff({ enabled, navigationType, alreadyHandled })).toBe(
        expected,
      );
    },
  );
});

describe("open-in-desktop setting", () => {
  it("defaults to false", () => {
    stubStorage();
    expect(readOpenInDesktop()).toBe(false);
  });

  it("round-trips through localStorage", () => {
    const store = stubStorage();
    writeOpenInDesktop(true);
    expect(store[KEY]).toBe("true");
    expect(readOpenInDesktop()).toBe(true);
    writeOpenInDesktop(false);
    expect(readOpenInDesktop()).toBe(false);
  });

  it("treats a missing or throwing storage as off", () => {
    expect(readOpenInDesktop()).toBe(false);
    expect(() => writeOpenInDesktop(true)).not.toThrow();

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readOpenInDesktop()).toBe(false);
    expect(() => writeOpenInDesktop(true)).not.toThrow();
  });
});
