"use client";

import { useEffect, useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "@multica/views/i18n";
import {
  handoffUrl,
  openDesktopApp,
  readOpenInDesktop,
  shouldHandOff,
  writeOpenInDesktop,
} from "@/platform/desktop-handoff";

// The check runs once per document load: client-side navigations that remount
// the workspace layout must never hand off, even after the setting changes.
let checked = false;

/**
 * Mounted ahead of the workspace layout's auth/onboarding gates so its effect
 * reads the original URL before any redirect replaces it.
 */
export function DesktopHandoff() {
  const { t } = useT("settings");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const handOff = shouldHandOff({
      enabled: readOpenInDesktop(),
      navigationType: entry?.type,
      alreadyHandled: checked,
    });
    checked = true;
    if (!handOff) return;
    const { pathname, search, hash } = window.location;
    openDesktopApp(handoffUrl(pathname, search, hash));
    setVisible(true);
  }, []);

  if (!visible) return null;

  const opened = t(($) => $.desktop.open_in_app.opened);
  return (
    <section
      aria-label={opened}
      className="fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <p className="text-body font-medium">{opened}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => setVisible(false)}>
          {t(($) => $.desktop.open_in_app.continue_in_browser)}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            writeOpenInDesktop(false);
            setVisible(false);
          }}
        >
          {t(($) => $.desktop.open_in_app.stop)}
        </Button>
      </div>
    </section>
  );
}
