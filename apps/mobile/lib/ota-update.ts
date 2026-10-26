/**
 * OTA update flow, kept free of React Native imports so it is unit-testable.
 * An update is downloaded in the background; the user is then told and may
 * restart now. Dismissing the prompt never reloads: the update simply applies
 * on the next normal launch, so nothing the user is typing is discarded.
 */
export interface OtaUpdateDeps {
  isEnabled: boolean;
  check(): Promise<{ isAvailable: boolean }>;
  fetch(): Promise<{ isNew: boolean }>;
  prompt(onRestart: () => void): void;
  reload(): Promise<void>;
  log(msg: string, err?: unknown): void;
}

export async function checkAndPromptForUpdate(deps: OtaUpdateDeps): Promise<void> {
  if (!deps.isEnabled) return;
  try {
    const { isAvailable } = await deps.check();
    if (!isAvailable) return;
    const { isNew } = await deps.fetch();
    if (!isNew) return;
    deps.prompt(() => {
      deps.reload().catch((err: unknown) => deps.log("OTA reload failed", err));
    });
  } catch (err) {
    deps.log("OTA update check failed", err);
  }
}

/**
 * Remembers which update ids already got a prompt, so the same downloaded
 * update is offered once however it arrived. Returns true the first time.
 */
export function createUpdatePromptGate(): (updateId: string) => boolean {
  const seen = new Set<string>();
  return (updateId) => {
    if (seen.has(updateId)) return false;
    seen.add(updateId);
    return true;
  };
}

/**
 * Prompts for an update that is already downloaded and waiting for a restart,
 * whichever path downloaded it (including the native ON_LOAD launch check,
 * which applies it silently on the next launch otherwise).
 */
export function promptForPendingUpdate(
  state: { isUpdatePending: boolean; updateId: string | undefined },
  firstTime: (updateId: string) => boolean,
  deps: Pick<OtaUpdateDeps, "prompt" | "reload" | "log">,
): void {
  if (!state.isUpdatePending || !state.updateId || !firstTime(state.updateId)) return;
  deps.prompt(() => {
    deps.reload().catch((err: unknown) => deps.log("OTA reload failed", err));
  });
}

export type ManualCheckResult = "prompted" | "up-to-date" | "error";

/**
 * User-initiated check from Settings. Unlike the automatic flow it reports an
 * outcome, ignores the 30-minute throttle, and re-offers an update that is
 * already downloaded and waiting for a restart.
 */
export async function manualUpdateCheck(
  deps: OtaUpdateDeps & { isUpdatePending: boolean },
): Promise<ManualCheckResult> {
  if (!deps.isEnabled) return "up-to-date";
  const prompt = () =>
    deps.prompt(() => {
      deps.reload().catch((err: unknown) => deps.log("OTA reload failed", err));
    });
  try {
    if (deps.isUpdatePending) {
      prompt();
      return "prompted";
    }
    const { isAvailable } = await deps.check();
    if (!isAvailable) return "up-to-date";
    const { isNew } = await deps.fetch();
    if (!isNew) return "up-to-date";
    prompt();
    return "prompted";
  } catch (err) {
    deps.log("OTA manual update check failed", err);
    return "error";
  }
}
