/**
 * Registers this phone's raw APNs token with the server (direct APNs, no
 * Expo relay). Environment comes from the signed entitlement, not __DEV__:
 * a Release build signed for development still talks to the APNs sandbox.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Application from "expo-application";
import * as SecureStore from "expo-secure-store";
import { api } from "@/data/api";

const TOKEN_KEY = "multica_push_token";

export async function registerForPush(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const current = await Notifications.getPermissionsAsync();
    const status = current.granted ? current : await Notifications.requestPermissionsAsync();
    if (!status.granted) return;
    const env = await Application.getIosPushNotificationServiceEnvironmentAsync();
    const bundleId = Application.applicationId;
    if (!env || !bundleId) return; // simulator / unsigned build
    const { data: token } = await Notifications.getDevicePushTokenAsync();
    if (typeof token !== "string" || !token) return;
    await api.registerPushDevice({
      platform: "ios",
      token,
      bundle_id: bundleId,
      environment: env === "production" ? "production" : "sandbox",
    });
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } catch (err) {
    console.log("[push] registration failed", err);
  }
}

export async function unregisterForPush(): Promise<void> {
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!token) return;
    await api.unregisterPushDevice(token);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch (err) {
    console.log("[push] unregister failed", err);
  }
}
