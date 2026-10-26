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
        registeredToken = result.token;
        window.desktopAPI.setPushActive(true);
      } catch {
        // Local banners stay on; nothing else to do.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId]);
  return null;
}
