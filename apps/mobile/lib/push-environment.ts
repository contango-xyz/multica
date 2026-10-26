export const PUSH_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * APNs environment from the signed aps-environment entitlement. TestFlight and
 * App Store builds have no embedded provisioning profile, so the entitlement
 * reads null there — and those talk to production APNs.
 */
export function resolvePushEnvironment(entitlement: string | null): "sandbox" | "production" {
  return entitlement === "development" ? "sandbox" : "production";
}

export function shouldReRegister(lastRegisteredAt: number | null, now: number): boolean {
  return lastRegisteredAt === null || now - lastRegisteredAt >= PUSH_REFRESH_MS;
}
