import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack, Redirect } from "expo-router";
import { useAuthStore } from "@/data/auth-store";
import { pendingLink } from "@/lib/universal-links";

/**
 * Auth-required layout. Redirects to /login when no user is loaded.
 *
 * Waits for the session restore first: a universal link opens this layout
 * directly on a cold start, before AuthInitializer has loaded the user, and
 * redirecting then would send a signed-in user to /login. A logged-out start
 * keeps the linked screen in `pendingLink` for verify to replay; once a user
 * is here the link has landed, so the pending copy is dropped.
 *
 * Workspace membership is enforced one level deeper at [workspace]/_layout —
 * not here — because select-workspace.tsx itself is auth-required but
 * workspace-less.
 */
export default function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);

  useEffect(() => {
    if (user) pendingLink.clear();
  }, [user]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }
  if (!user) return <Redirect href="/login" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
