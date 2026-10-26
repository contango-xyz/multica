import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("@multica/core/api", () => ({
  api: {
    registerPushDevice: vi.fn(async () => {}),
    unregisterPushDevice: vi.fn(async () => {}),
  },
}));

import { api } from "@multica/core/api";
import {
  DesktopPushBridge,
  unregisterPushOnLogout,
} from "./desktop-push-bridge";

type DesktopAPIStub = Record<string, unknown>;
const w = window as unknown as { desktopAPI: DesktopAPIStub };
let original: DesktopAPIStub;

beforeEach(() => {
  original = w.desktopAPI;
  vi.clearAllMocks();
});
afterEach(() => {
  w.desktopAPI = original;
});

describe("DesktopPushBridge", () => {
  it("registers the APNs token with the server and turns local banners off", async () => {
    const setPushActive = vi.fn();
    w.desktopAPI = { registerPush: vi.fn(async () => ({ token: "tok" })), setPushActive };
    render(<DesktopPushBridge appId="com.example.desktop" />);
    await waitFor(() =>
      expect(api.registerPushDevice).toHaveBeenCalledWith({
        platform: "macos",
        token: "tok",
        bundle_id: "com.example.desktop",
        environment: "production",
      }),
    );
    await waitFor(() => expect(setPushActive).toHaveBeenCalledWith(true));
  });

  it("keeps local banners when registration fails", async () => {
    const setPushActive = vi.fn();
    const registerPush = vi.fn(async () => ({ error: "denied" }));
    w.desktopAPI = { registerPush, setPushActive };
    render(<DesktopPushBridge appId="com.example.desktop" />);
    await waitFor(() => expect(registerPush).toHaveBeenCalled());
    expect(api.registerPushDevice).not.toHaveBeenCalled();
    expect(setPushActive).not.toHaveBeenCalledWith(true);
  });

  it("does nothing on an upstream build", () => {
    const registerPush = vi.fn();
    w.desktopAPI = { registerPush };
    render(<DesktopPushBridge appId="" />);
    expect(registerPush).not.toHaveBeenCalled();
  });

  it("unregisters on logout without throwing, even if the server call rejects", async () => {
    const setPushActive = vi.fn();
    w.desktopAPI = { registerPush: vi.fn(async () => ({ token: "tok2" })), setPushActive };
    render(<DesktopPushBridge appId="com.example.desktop" />);
    await waitFor(() => expect(setPushActive).toHaveBeenCalledWith(true));
    vi.mocked(api.unregisterPushDevice).mockRejectedValueOnce(new Error("offline"));
    expect(() => unregisterPushOnLogout()).not.toThrow();
    expect(setPushActive).toHaveBeenLastCalledWith(false);
    expect(api.unregisterPushDevice).toHaveBeenCalledWith("tok2");
    await Promise.resolve();
  });
});
