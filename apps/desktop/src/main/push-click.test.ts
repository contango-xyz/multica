// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PushClicks, startNativePushClicks, type PushClickOptions } from "./push-click";

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

const inboxPush = { aps: {}, body: { kind: "inbox", workspace_slug: "w", item_id: "i1", issue_id: "is1" } };
const inboxRoute = { kind: "inbox", slug: "w", itemId: "i1", issueKey: "is1" };

function pushClicks() {
  const open = vi.fn();
  const focus = vi.fn();
  return { open, focus, clicks: new PushClicks({ open, focus }) };
}

// Starts with a fake addon; returns the click callback it was handed.
function startWith(clicks: PushClicks, launchInfo: unknown, active = true) {
  let onClick: (click: unknown) => void = () => {};
  const started = clicks.start(launchInfo, (cb) => {
    onClick = cb;
    return active;
  });
  return { started, click: (c: unknown) => onClick(c) };
}

describe("PushClicks", () => {
  it("opens the route of the clicked notification", () => {
    const { open, focus, clicks } = pushClicks();
    const { started, click } = startWith(clicks, undefined);
    expect(started).toBe(true);
    click({ identifier: "n1", userInfo: inboxPush });
    expect(open).toHaveBeenCalledWith(inboxRoute);
    expect(focus).not.toHaveBeenCalled();
  });

  it("skips the click that cold-launched the app (launchInfo already opens it)", () => {
    const { open, clicks } = pushClicks();
    const { click } = startWith(clicks, { identifier: "n1", userInfo: inboxPush });
    click({ identifier: "n1", userInfo: inboxPush });
    expect(open).not.toHaveBeenCalled();
    click({ identifier: "n2", userInfo: inboxPush });
    expect(open).toHaveBeenCalledWith(inboxRoute);
  });

  it("does not dedupe clicks without an identifier", () => {
    const { open, clicks } = pushClicks();
    const { click } = startWith(clicks, { userInfo: inboxPush });
    click({ userInfo: inboxPush });
    expect(open).toHaveBeenCalledWith(inboxRoute);
  });

  it.each([
    ["unroutable userInfo", { identifier: "n1", userInfo: { aps: {} } }],
    ["userInfo the addon could not serialise", { identifier: "n1", userInfo: null }],
    ["a malformed click", "nonsense"],
  ])("brings the app forward for %s", (_name, c) => {
    const { open, focus, clicks } = pushClicks();
    startWith(clicks, undefined).click(c);
    expect(open).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("ignores the RecentPush heuristic while native clicks are live", () => {
    const { open, clicks } = pushClicks();
    startWith(clicks, undefined);
    clicks.received(inboxPush, false);
    clicks.activated();
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to RecentPush when the addon is not running", () => {
    const { open, clicks } = pushClicks();
    expect(startWith(clicks, undefined, false).started).toBe(false);
    clicks.received(inboxPush, false);
    clicks.activated();
    expect(open).toHaveBeenLastCalledWith(inboxRoute);
  });

  it("uses RecentPush for pushes received before start (app not ready yet)", () => {
    const { open, clicks } = pushClicks();
    clicks.received(inboxPush, true); // in front: no click candidate
    clicks.activated();
    expect(open).toHaveBeenLastCalledWith(null);
  });
});
