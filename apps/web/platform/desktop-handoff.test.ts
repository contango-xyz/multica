// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handoffUrl,
  markCheckedInTab,
  readCheckedInTab,
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

function stubSession() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
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
  const base = {
    enabled: true,
    navigationType: "navigate",
    alreadyHandled: false,
    checkedInTab: false,
    referrer: "",
    origin: "https://app.example.com",
  };

  it.each([
    [{}, true],
    [{ enabled: false }, false],
    [{ navigationType: "reload" }, false],
    [{ navigationType: "back_forward" }, false],
    [{ navigationType: "prerender" }, false],
    [{ navigationType: undefined }, false],
    [{ alreadyHandled: true }, false],
    [{ checkedInTab: true }, false],
    [{ referrer: "https://app.example.com/acme/inbox" }, false],
    [{ referrer: "https://github.com/acme/pull/1" }, true],
    [{ referrer: "not a url" }, true],
  ] as const)("%j -> %s", (override, expected) => {
    expect(shouldHandOff({ ...base, ...override })).toBe(expected);
  });
});

describe("tab check flag", () => {
  it("is unset until marked, then set", () => {
    vi.stubGlobal("sessionStorage", stubSession());
    expect(readCheckedInTab()).toBe(false);
    markCheckedInTab();
    expect(readCheckedInTab()).toBe(true);
  });

  it("reads as unchecked and does not throw when storage throws", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readCheckedInTab()).toBe(false);
    expect(() => markCheckedInTab()).not.toThrow();
  });
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
