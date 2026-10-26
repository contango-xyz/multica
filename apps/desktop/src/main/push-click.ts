import { join } from "node:path";
import { RecentPush, routeForPushPayload, type PushRoute } from "./push";

// Fork builds ship native/push-click as Resources/push-click.node (see
// scripts/contango-build.mjs). It reports every default-action click on an APNs
// notification as { identifier, userInfo } (userInfo null when it could not be
// serialised); Electron itself drops those clicks while the app runs.
export const PUSH_CLICK_ADDON_FILE = "push-click.node";

type PushClickAddon = { start(onClick: (click: unknown) => void): boolean };

export type PushClickOptions = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  // Creates Electron's notification presenter, which installs the
  // UNUserNotificationCenter delegate the addon hooks.
  ensureNotificationDelegate: () => void;
  load: (path: string) => unknown;
  onClick: (click: unknown) => void;
  log?: (message: string) => void;
};

// True when native click reporting is live; callers then skip the
// RecentPush activation heuristic. Upstream and dev builds have no addon.
export function startNativePushClicks(opts: PushClickOptions): boolean {
  const log = opts.log ?? (() => {});
  if (opts.platform !== "darwin" || !opts.isPackaged) {
    log("native push clicks: off (not a packaged macOS app)");
    return false;
  }
  try {
    const addon = opts.load(join(opts.resourcesPath, PUSH_CLICK_ADDON_FILE)) as Partial<PushClickAddon>;
    if (typeof addon?.start !== "function") {
      log("native push clicks: off (addon has no start())");
      return false;
    }
    // Only once the addon loaded: creating the presenter early asks for
    // notification permission, which upstream builds must not do at launch.
    opts.ensureNotificationDelegate();
    const started = addon.start(opts.onClick) === true;
    log(started ? "native push clicks: on" : "native push clicks: off (start() refused the delegate)");
    return started;
  } catch (err) {
    log(`native push clicks: off (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

export function loadNativeAddon(path: string): unknown {
  const mod = { exports: {} as unknown };
  process.dlopen(mod, path);
  return mod.exports;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

// Decides what a push click does: native clicks when the addon runs, else the
// RecentPush activation heuristic.
export class PushClicks {
  private native = false;
  private launchIdentifier = "";
  private readonly recent = new RecentPush();

  constructor(
    private readonly deps: {
      open: (route: PushRoute | null) => void;
      focus: () => void;
      log?: (message: string) => void;
    },
  ) {}

  // From app 'ready'. Electron may also hand the click that cold-launched the
  // app to the hooked delegate; launchInfo already opens that one.
  start(launchInfo: unknown, startNative: (onClick: (click: unknown) => void) => boolean): boolean {
    this.launchIdentifier = str((launchInfo as { identifier?: unknown } | null)?.identifier);
    this.native = startNative((click) => this.clicked(click));
    return this.native;
  }

  private clicked(click: unknown): void {
    const { identifier, userInfo } = (click ?? {}) as { identifier?: unknown; userInfo?: unknown };
    if (this.launchIdentifier && str(identifier) === this.launchIdentifier) {
      this.deps.log?.("click: skipped (the push that launched the app)");
      return;
    }
    const route = routeForPushPayload(userInfo);
    this.deps.log?.(`click: ${route ? route.kind : "no route"}`);
    if (route) this.deps.open(route);
    else this.deps.focus(); // nothing to route to: the app still comes forward
  }

  // A push that arrives while the app is in front is no click candidate: no
  // activation follows a click on it.
  received(userInfo: unknown, appFocused: boolean): void {
    const route = routeForPushPayload(userInfo);
    this.deps.log?.(`received: ${route?.kind ?? "no route"}${appFocused ? " (app focused)" : ""}`);
    if (!this.native) this.recent.received(appFocused ? null : route);
  }

  activated(): void {
    if (this.native) return;
    const route = this.recent.takeOnActivate();
    if (route) this.deps.log?.(`activated: opening ${route.kind} (fallback)`);
    this.deps.open(route);
  }
}
