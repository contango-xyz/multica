import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  getEnv: vi.fn(),
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  registerPushDevice: vi.fn(),
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: m.getPermissionsAsync,
  requestPermissionsAsync: m.requestPermissionsAsync,
  getDevicePushTokenAsync: m.getDevicePushTokenAsync,
}));
vi.mock("expo-application", () => ({
  getIosPushNotificationServiceEnvironmentAsync: m.getEnv,
  applicationId: "test.bundle.id",
}));
vi.mock("expo-secure-store", () => ({
  setItemAsync: m.setItemAsync,
  getItemAsync: m.getItemAsync,
  deleteItemAsync: vi.fn(),
}));
vi.mock("@/data/api", () => ({ api: { registerPushDevice: m.registerPushDevice, unregisterPushDevice: vi.fn() } }));

import { registerForPush } from "./push-registration";

describe("registerForPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    m.getPermissionsAsync.mockResolvedValue({ granted: true });
    m.getEnv.mockResolvedValue(null);
    m.getDevicePushTokenAsync.mockResolvedValue({ data: "token-1" });
    m.getItemAsync.mockResolvedValue(null);
  });

  it("does not call the API when permission is denied", async () => {
    m.getPermissionsAsync.mockResolvedValue({ granted: false });
    m.requestPermissionsAsync.mockResolvedValue({ granted: false });
    await registerForPush();
    expect(m.registerPushDevice).not.toHaveBeenCalled();
  });

  it("registers as production when there is no entitlement (TestFlight)", async () => {
    await registerForPush();
    expect(m.registerPushDevice).toHaveBeenCalledWith({
      platform: "ios",
      token: "token-1",
      bundle_id: "test.bundle.id",
      environment: "production",
    });
  });

  it("registers a token different from the stored one and stores the new one", async () => {
    m.getItemAsync.mockResolvedValue("old-token");
    m.getDevicePushTokenAsync.mockResolvedValue({ data: "new-token" });
    await registerForPush();
    expect(m.registerPushDevice).toHaveBeenCalledWith(expect.objectContaining({ token: "new-token" }));
    expect(m.setItemAsync).toHaveBeenCalledWith("multica_push_token", "new-token");
  });
});
