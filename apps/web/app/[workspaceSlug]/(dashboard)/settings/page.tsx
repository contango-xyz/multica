"use client";

import { AppWindow } from "lucide-react";
import { SettingsPage } from "@multica/views/settings";
import { useT } from "@multica/views/i18n";
import { OpenInDesktopSetting } from "@/components/open-in-desktop-setting";

export default function Page() {
  const { t } = useT("settings");
  return (
    <SettingsPage
      extraDeviceTabs={[
        {
          value: "desktop-app",
          label: t(($) => $.desktop.open_in_app.tab),
          icon: AppWindow,
          content: <OpenInDesktopSetting />,
        },
      ]}
    />
  );
}
