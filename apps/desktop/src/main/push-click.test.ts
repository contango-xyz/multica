// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { startNativePushClicks, type PushClickOptions } from "./push-click";

function options(overrides: Partial<PushClickOptions> = {}): PushClickOptions {
  return {
    platform: "darwin",
    isPackaged: true,
    resourcesPath: "/App/Contents/Resources",
    ensureNotificationDelegate: vi.fn(),
    load: vi.fn(() => ({ start: () => true })),
    onClick: vi.fn(),
    ...overrides,
  };
}

describe("startNativePushClicks", () => {
  it("loads the addon from Resources, then creates the delegate and starts with the click handler", () => {
    const calls: string[] = [];
    const start = vi.fn(() => true);
    const opts = options({
      ensureNotificationDelegate: () => calls.push("delegate"),
      load: (path) => {
        calls.push(path);
        return { start };
      },
    });
    expect(startNativePushClicks(opts)).toBe(true);
    expect(calls).toEqual(["/App/Contents/Resources/push-click.node", "delegate"]);
    expect(start).toHaveBeenCalledWith(opts.onClick);
  });

  it.each([
    ["not macOS", { platform: "linux" as const }],
    ["not packaged (dev)", { isPackaged: false }],
  ])("stays off when %s", (_name, overrides) => {
    const opts = options(overrides);
    expect(startNativePushClicks(opts)).toBe(false);
    expect(opts.load).not.toHaveBeenCalled();
  });

  it.each([
    ["the addon is missing (upstream build)", () => {
      throw new Error("dlopen failed");
    }],
    ["the module has no start()", () => ({})],
  ])("falls back without touching notifications when %s", (_name, load) => {
    const opts = options({ load });
    expect(startNativePushClicks(opts)).toBe(false);
    expect(opts.ensureNotificationDelegate).not.toHaveBeenCalled();
  });

  it("falls back when start() refuses (Electron's delegate not found)", () => {
    expect(startNativePushClicks(options({ load: () => ({ start: () => false }) }))).toBe(false);
  });

  it("falls back when creating the delegate throws", () => {
    const opts = options({
      ensureNotificationDelegate: () => {
        throw new Error("no presenter");
      },
    });
    expect(startNativePushClicks(opts)).toBe(false);
  });
});
