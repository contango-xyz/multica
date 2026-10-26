/**
 * Offers a restart whenever an OTA update has been downloaded, by any path:
 * the native launch check (`checkAutomatically: "ON_LOAD"`) or this hook's own
 * check on launch / foreground (at most once per 30 minutes). `useUpdates()`
 * reports the downloaded update either way, so one prompt per update id covers
 * both. A no-op in dev / dev-client builds, where `Updates.isEnabled` is false.
 */
import { useEffect, useRef } from "react";
import { Alert, AppState } from "react-native";
import * as Updates from "expo-updates";
import { useT } from "@/lib/i18n";
import {
  checkAndPromptForUpdate,
  manualUpdateCheck,
  type ManualCheckResult,
  createUpdatePromptGate,
  promptForPendingUpdate,
} from "@/lib/ota-update";

const MIN_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Shared by the automatic hook and the manual Settings check, so one update id
// is offered at most once by the automatic paths.
const promptGate = createUpdatePromptGate();

type TFn = ReturnType<typeof useT>["t"];

function showUpdatePrompt(t: TFn, onRestart: () => void): void {
  Alert.alert(t("ota.title"), t("ota.message"), [
    { text: t("ota.later"), style: "cancel" },
    { text: t("ota.restart"), onPress: onRestart },
  ]);
}

/** Manual "Check for updates": ignores the throttle, uses the shared prompt. */
export function checkForUpdateManually(t: TFn, isUpdatePending: boolean): Promise<ManualCheckResult> {
  let fetchedId: string | undefined;
  return manualUpdateCheck({
    isEnabled: Updates.isEnabled,
    isUpdatePending,
    check: () => Updates.checkForUpdateAsync(),
    fetch: async () => {
      const result = await Updates.fetchUpdateAsync();
      if (result.isNew) fetchedId = result.manifest?.id;
      return { isNew: result.isNew };
    },
    prompt: (onRestart) => {
      // Mark as seen so the automatic paths do not prompt again for it.
      if (fetchedId) promptGate(fetchedId);
      showUpdatePrompt(t, onRestart);
    },
    reload: () => Updates.reloadAsync(),
    log: (msg, err) => console.warn(msg, err),
  });
}

export function useOtaUpdatePrompt(): void {
  const { t } = useT("common");
  // Ref so a language change neither re-runs the effect nor resets the throttle.
  const tRef = useRef(t);
  tRef.current = t;
  const gateRef = useRef(promptGate);
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();

  const showPrompt = (onRestart: () => void) => showUpdatePrompt(tRef.current, onRestart);
  const showPromptRef = useRef(showPrompt);
  showPromptRef.current = showPrompt;

  const pendingDeps = {
    prompt: (onRestart: () => void) => showPromptRef.current(onRestart),
    reload: () => Updates.reloadAsync(),
    log: (msg: string, err?: unknown) => console.warn(msg, err),
  };

  const updateId = downloadedUpdate?.updateId;
  useEffect(() => {
    if (!Updates.isEnabled) return;
    promptForPendingUpdate({ isUpdatePending, updateId }, gateRef.current, pendingDeps);
    // pendingDeps only holds refs and module functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUpdatePending, updateId]);

  useEffect(() => {
    if (!Updates.isEnabled) return;
    let lastCheck = 0;
    let busy = false;

    const run = async () => {
      const now = Date.now();
      if (busy || now - lastCheck < MIN_CHECK_INTERVAL_MS) return;
      busy = true;
      lastCheck = now;
      try {
        let fetchedId: string | undefined;
        await checkAndPromptForUpdate({
          isEnabled: Updates.isEnabled,
          check: () => Updates.checkForUpdateAsync(),
          fetch: async () => {
            const result = await Updates.fetchUpdateAsync();
            if (result.isNew) fetchedId = result.manifest?.id;
            return { isNew: result.isNew };
          },
          prompt: (onRestart) => {
            // Same gate as the pending-update effect: one prompt per update id.
            if (!fetchedId || gateRef.current(fetchedId)) showPromptRef.current(onRestart);
          },
          reload: () => Updates.reloadAsync(),
          log: pendingDeps.log,
        });
      } finally {
        busy = false;
      }
    };

    void run();
    const sub = AppState.addEventListener("change", (status) => {
      if (status === "active") void run();
    });
    return () => sub.remove();
    // pendingDeps.log is a stable console wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
