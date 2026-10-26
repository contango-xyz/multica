/**
 * Checks for an OTA update on launch and when the app returns to the
 * foreground (at most once per 30 minutes), then offers a restart. A no-op in
 * dev / dev-client builds, where `Updates.isEnabled` is false.
 */
import { useEffect } from "react";
import { Alert, AppState } from "react-native";
import * as Updates from "expo-updates";
import { useT } from "@/lib/i18n";
import { checkAndPromptForUpdate } from "@/lib/ota-update";

const MIN_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function useOtaUpdatePrompt(): void {
  const { t } = useT("common");

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
        await checkAndPromptForUpdate({
          isEnabled: Updates.isEnabled,
          check: () => Updates.checkForUpdateAsync(),
          fetch: async () => {
            const result = await Updates.fetchUpdateAsync();
            return { isNew: result.isNew };
          },
          prompt: (onRestart) =>
            Alert.alert(t("ota.title"), t("ota.message"), [
              { text: t("ota.later"), style: "cancel" },
              { text: t("ota.restart"), onPress: onRestart },
            ]),
          reload: () => Updates.reloadAsync(),
          log: (msg, err) => console.warn(msg, err),
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
  }, [t]);
}
