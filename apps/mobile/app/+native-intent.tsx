import { useAuthStore } from "@/data/auth-store";
import { pendingLink, redirectLink } from "@/lib/universal-links";

/**
 * Expo Router passes every incoming URL here (cold start and while running).
 * Universal links are mapped from web paths to mobile routes. Without a
 * signed-in user (logged out, or a cold start still restoring the session)
 * the mapped screen is also remembered so sign-in can return to it; see
 * app/(app)/_layout.tsx and app/(auth)/verify.tsx.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const mapped = redirectLink(path);
    if (mapped !== path && !useAuthStore.getState().user) pendingLink.remember(mapped);
    return mapped;
  } catch {
    return path;
  }
}
