import { describe, expect, it, vi } from "vitest";
import {
  checkAndPromptForUpdate,
  createUpdatePromptGate,
  manualUpdateCheck,
  promptForPendingUpdate,
  type OtaUpdateDeps,
} from "./ota-update";

function makeDeps(over: Partial<OtaUpdateDeps> = {}) {
  return {
    isEnabled: true,
    check: vi.fn(async () => ({ isAvailable: true })),
    fetch: vi.fn(async () => ({ isNew: true })),
    prompt: vi.fn<(onRestart: () => void) => void>(),
    reload: vi.fn(async () => {}),
    log: vi.fn(),
    ...over,
  } as OtaUpdateDeps & { prompt: ReturnType<typeof vi.fn<(onRestart: () => void) => void>> };
}

describe("checkAndPromptForUpdate", () => {
  it("does nothing when updates are disabled", async () => {
    const deps = makeDeps({ isEnabled: false });
    await checkAndPromptForUpdate(deps);
    expect(deps.check).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("neither fetches nor prompts when no update is available", async () => {
    const deps = makeDeps({ check: vi.fn(async () => ({ isAvailable: false })) });
    await checkAndPromptForUpdate(deps);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("does not prompt when the fetched update is not new", async () => {
    const deps = makeDeps({ fetch: vi.fn(async () => ({ isNew: false })) });
    await checkAndPromptForUpdate(deps);
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("prompts once after downloading a new update, without reloading by itself", async () => {
    const deps = makeDeps();
    await checkAndPromptForUpdate(deps);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.prompt).toHaveBeenCalledTimes(1);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("reloads only when the user chooses restart", async () => {
    const deps = makeDeps();
    await checkAndPromptForUpdate(deps);
    deps.prompt.mock.calls[0]![0]();
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads when the prompt is dismissed", async () => {
    const deps = makeDeps();
    await checkAndPromptForUpdate(deps);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("logs and does not throw when the check fails", async () => {
    const err = new Error("offline");
    const deps = makeDeps({ check: vi.fn(async () => { throw err; }) });
    await expect(checkAndPromptForUpdate(deps)).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(expect.any(String), err);
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("logs when a restart reload fails", async () => {
    const err = new Error("boom");
    const deps = makeDeps({ reload: vi.fn(async () => { throw err; }) });
    await checkAndPromptForUpdate(deps);
    deps.prompt.mock.calls[0]![0]();
    await Promise.resolve();
    expect(deps.log).toHaveBeenCalledWith(expect.any(String), err);
  });
});

describe("promptForPendingUpdate", () => {
  it("prompts once for an update the native launch check downloaded", () => {
    const seen = createUpdatePromptGate();
    const prompt = vi.fn<(onRestart: () => void) => void>();
    const reload = vi.fn(async () => {});
    const log = vi.fn();
    const pending = { isUpdatePending: true, updateId: "u1" };
    promptForPendingUpdate(pending, seen, { prompt, reload, log });
    promptForPendingUpdate(pending, seen, { prompt, reload, log });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("prompts again for a different update id", () => {
    const seen = createUpdatePromptGate();
    const prompt = vi.fn<(onRestart: () => void) => void>();
    const deps = { prompt, reload: vi.fn(async () => {}), log: vi.fn() };
    promptForPendingUpdate({ isUpdatePending: true, updateId: "u1" }, seen, deps);
    promptForPendingUpdate({ isUpdatePending: true, updateId: "u2" }, seen, deps);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("does not prompt when nothing is pending", () => {
    const prompt = vi.fn<(onRestart: () => void) => void>();
    promptForPendingUpdate({ isUpdatePending: false, updateId: "u1" }, createUpdatePromptGate(), {
      prompt,
      reload: vi.fn(async () => {}),
      log: vi.fn(),
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("reloads only on restart, never on dismiss", () => {
    const prompt = vi.fn<(onRestart: () => void) => void>();
    const reload = vi.fn(async () => {});
    promptForPendingUpdate({ isUpdatePending: true, updateId: "u1" }, createUpdatePromptGate(), {
      prompt,
      reload,
      log: vi.fn(),
    });
    expect(reload).not.toHaveBeenCalled();
    prompt.mock.calls[0]![0]();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a fetch that finds the already-prompted update does not prompt twice", () => {
    const seen = createUpdatePromptGate();
    expect(seen("u1")).toBe(true);
    expect(seen("u1")).toBe(false);
  });
});

describe("manualUpdateCheck", () => {
  const manual = (over: Partial<OtaUpdateDeps> = {}, pending = false) =>
    ({ ...makeDeps(over), isUpdatePending: pending });

  it("prompts after fetching a new update", async () => {
    const deps = manual();
    expect(await manualUpdateCheck(deps)).toBe("prompted");
    expect(deps.prompt).toHaveBeenCalledOnce();
  });
  it("reports up-to-date when nothing is available or fetched", async () => {
    expect(await manualUpdateCheck(manual({ check: async () => ({ isAvailable: false }) }))).toBe("up-to-date");
    const deps = manual({ fetch: async () => ({ isNew: false }) });
    expect(await manualUpdateCheck(deps)).toBe("up-to-date");
    expect(deps.prompt).not.toHaveBeenCalled();
  });
  it("re-prompts an already downloaded update without checking", async () => {
    const deps = manual({}, true);
    expect(await manualUpdateCheck(deps)).toBe("prompted");
    expect(deps.check).not.toHaveBeenCalled();
  });
  it("returns error and logs when the check throws", async () => {
    const deps = manual({ check: async () => { throw new Error("offline"); } });
    expect(await manualUpdateCheck(deps)).toBe("error");
    expect(deps.log).toHaveBeenCalled();
  });
  it("does nothing when updates are disabled", async () => {
    const deps = manual({ isEnabled: false });
    expect(await manualUpdateCheck(deps)).toBe("up-to-date");
    expect(deps.check).not.toHaveBeenCalled();
  });
  it("reloads when the prompt's restart is chosen", async () => {
    const deps = manual();
    await manualUpdateCheck(deps);
    deps.prompt.mock.calls[0][0]();
    expect(deps.reload).toHaveBeenCalled();
  });
});
