import { describe, expect, it, vi } from "vitest";
import { checkAndPromptForUpdate, type OtaUpdateDeps } from "./ota-update";

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
