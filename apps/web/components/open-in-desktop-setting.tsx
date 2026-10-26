"use client";

import { useState } from "react";
import { Switch } from "@multica/ui/components/ui/switch";
import { useT } from "@multica/views/i18n";
import { SettingsCard, SettingsRow, SettingsTab } from "@multica/views/settings";
import { readOpenInDesktop, writeOpenInDesktop } from "@/platform/desktop-handoff";

export function OpenInDesktopSetting() {
  const { t } = useT("settings");
  const [enabled, setEnabled] = useState(readOpenInDesktop);
  const label = t(($) => $.desktop.open_in_app.toggle);

  return (
    <SettingsTab title={t(($) => $.desktop.open_in_app.tab)}>
      <SettingsCard>
        <SettingsRow label={label}>
          <Switch
            checked={enabled}
            onCheckedChange={(value) => {
              writeOpenInDesktop(value);
              setEnabled(value);
            }}
            aria-label={label}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsTab>
  );
}
