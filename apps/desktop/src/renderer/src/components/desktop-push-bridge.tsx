import { useEffect } from "react";
import { api } from "@multica/core/api";

// The APNs token of this Mac while a user is logged in; read by beforeLogout.
let registeredToken: string | null = null;

export function unregisterPushOnLogout(): void {
  const token = registeredToken;
  registeredToken = null;
  window.desktopAPI.setPushActive?.(false);
  if (token) void api.unregisterPushDevice(token).catch(() => {});
}

// Mounted inside the logged-in shell. Registers this Mac for APNs and tells
// main to stop local banners so a notification never shows twice.
export function DesktopPushBridge({ appId }: { appId: string }) {
  useEffect(() => {
    if (!appId || !window.desktopAPI.registerPush) return;
    let cancelled = false;
    // Local banners stay on until the server has this device.
    window.desktopAPI.setPushActive(false);
    void (async () => {
      const result = await window.desktopAPI.registerPush();
      if (cancelled || !("token" in result)) return;
      try {
        await api.registerPushDevice({
          platform: "macos",
          token: result.token,
          bundle_id: appId,
          environment: "production",
        });
      } catch {
        return; // Local banners stay on; nothing else to do.
      }
      if (cancelled) {
        // Logged out while the POST was in flight. Best effort only: the auth
        // token may already be gone, and a logout DELETE can reach the server
        // before this upsert, so the device can linger until the server's
        // 30-day last-seen cutoff.
        void api.unregisterPushDevice(result.token).catch(() => {});
        return;
      }
      registeredToken = result.token;
      window.desktopAPI.setPushActive(true);
    })();
    return () => {
      cancelled = true;
      // Covers session expiry, where beforeLogout does not run.
      window.desktopAPI.setPushActive(false);
    };
  }, [appId]);
  return null;
}
