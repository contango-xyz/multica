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
};

// True when native click reporting is live; callers then skip the
// RecentPush activation heuristic. Upstream and dev builds have no addon.
export function startNativePushClicks(opts: PushClickOptions): boolean {
  if (opts.platform !== "darwin" || !opts.isPackaged) return false;
  try {
    const addon = opts.load(join(opts.resourcesPath, PUSH_CLICK_ADDON_FILE)) as Partial<PushClickAddon>;
    if (typeof addon?.start !== "function") return false;
    // Only once the addon loaded: creating the presenter early asks for
    // notification permission, which upstream builds must not do at launch.
    opts.ensureNotificationDelegate();
    return addon.start(opts.onClick) === true;
  } catch {
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
    private readonly deps: { open: (route: PushRoute | null) => void; focus: () => void },
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
    if (this.launchIdentifier && str(identifier) === this.launchIdentifier) return;
    const route = routeForPushPayload(userInfo);
    if (route) this.deps.open(route);
    else this.deps.focus(); // nothing to route to: the app still comes forward
  }

  // A push that arrives while the app is in front is no click candidate: no
  // activation follows a click on it.
  received(userInfo: unknown, appFocused: boolean): void {
    if (!this.native) this.recent.received(appFocused ? null : routeForPushPayload(userInfo));
  }

  activated(): void {
    if (!this.native) this.deps.open(this.recent.takeOnActivate());
  }
}
