import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getToken: vi.fn(),
  restoreSlug: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { getMe: m.getMe, setToken: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(public status: number) {
      super(`status ${status}`);
    }
  },
}));
vi.mock("./secure-storage", () => ({
  getToken: m.getToken,
  setToken: vi.fn(),
  clearToken: vi.fn(),
}));
vi.mock("./session-epoch", () => ({ invalidateSessionEpoch: vi.fn() }));
vi.mock("./workspace-store", () => ({
  useWorkspaceStore: { getState: () => ({ restoreSlug: m.restoreSlug }) },
}));

import { useAuthStore } from "./auth-store";

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null, isLoading: true });
  m.restoreSlug.mockResolvedValue(undefined);
});

describe("initialize", () => {
  it("stops loading when the Keychain read throws", async () => {
    m.getToken.mockRejectedValue(new Error("keychain locked"));
    await expect(useAuthStore.getState().initialize()).rejects.toThrow("keychain locked");
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it("stops loading when restoring the workspace throws", async () => {
    m.restoreSlug.mockRejectedValue(new Error("storage"));
    await expect(useAuthStore.getState().initialize()).rejects.toThrow("storage");
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it("restores the user from a stored token", async () => {
    m.getToken.mockResolvedValue("t");
    m.getMe.mockResolvedValue({ id: "u1" });
    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState()).toMatchObject({ user: { id: "u1" }, isLoading: false });
  });
});
