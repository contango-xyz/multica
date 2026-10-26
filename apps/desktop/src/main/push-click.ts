import { join } from "node:path";

// Fork builds ship native/push-click as Resources/push-click.node (see
// scripts/contango-build.mjs). It reports every click on an APNs notification
// with its userInfo; Electron itself drops those clicks while the app runs.
export const PUSH_CLICK_ADDON_FILE = "push-click.node";

type PushClickAddon = { start(onClick: (userInfo: unknown) => void): boolean };

export type PushClickOptions = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  // Creates Electron's notification presenter, which installs the
  // UNUserNotificationCenter delegate the addon hooks.
  ensureNotificationDelegate: () => void;
  load: (path: string) => unknown;
  onClick: (userInfo: unknown) => void;
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
