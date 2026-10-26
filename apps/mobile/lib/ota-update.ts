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
