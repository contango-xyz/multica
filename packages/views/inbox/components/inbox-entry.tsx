"use client";

// Chooses between the classic inbox and the contango smart inbox
// (docs/contango/SMART-INBOX.md). The server flag for the current user
// (`user.smart_inbox`) turns it on; Smart is then the default, web and desktop
// alike (owner 2026-11-07), and the header toggle switches to Classic
// (remembered). `?smart-inbox=0` picks Classic. Without the flag the classic
// page renders unchanged.

import { useEffect, useState } from "react";
import { useAuthStore } from "@multica/core/auth";
import {
  SMART_INBOX_URL_PARAM,
  smartInboxModeFromParam,
  type SmartInboxMode,
} from "@multica/core/inbox/smart";
import { Button } from "@multica/ui/components/ui/button";
import { useIsCompact } from "@multica/ui/hooks/use-mobile";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { Sparkles } from "@multica/ui/icons";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { InboxPage as ClassicInboxPage } from "./inbox-page";
import { SmartInboxPage } from "./smart-inbox";
import { ARCHIVED_VIEW_PARAM } from "./inbox-view";

const STORAGE_KEY = "multica:smart-inbox";

function readStoredMode(): SmartInboxMode | null {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === "smart" || v === "classic" ? v : null;
  } catch {
    return null;
  }
}

function writeStoredMode(mode: SmartInboxMode | null) {
  try {
    if (mode) globalThis.localStorage?.setItem(STORAGE_KEY, mode);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, sandbox): the choice lasts this visit.
  }
}

export function useSmartInboxMode(): [SmartInboxMode, (m: SmartInboxMode) => void] {
  const { searchParams } = useNavigation();
  const param = searchParams.get(SMART_INBOX_URL_PARAM);
  const [mode, setMode] = useState<SmartInboxMode>(() =>
    smartInboxModeFromParam(param, readStoredMode()),
  );
  useEffect(() => {
    const next = smartInboxModeFromParam(param, readStoredMode());
    // Only an explicit choice is remembered, so the default can change later.
    if (param === "0" || param === "1") writeStoredMode(next);
    setMode(next);
  }, [param]);
  const choose = (m: SmartInboxMode) => {
    writeStoredMode(m);
    setMode(m);
  };
  return [mode, choose];
}

function InboxModeToggle({
  mode,
  onChange,
}: {
  mode: SmartInboxMode;
  onChange: (m: SmartInboxMode) => void;
}) {
  const { t } = useT("inbox");
  const isCompact = useIsCompact();
  if (!isCompact) {
    // The two-pane list header is narrow and also carries Classic's filter
    // and bulk menus, so the toggle is one icon button there.
    const next = mode === "smart" ? "classic" : "smart";
    return (
      <IconButton
        label={next === "classic" ? t(($) => $.smart.switch_to_classic) : t(($) => $.smart.switch_to_smart)}
        tooltipSide="bottom"
        variant={mode === "smart" ? "secondary" : "ghost"}
        aria-pressed={mode === "smart"}
        className="text-muted-foreground"
        onClick={() => onChange(next)}
      >
        <Sparkles className="size-4" />
      </IconButton>
    );
  }
  return (
    <div role="group" aria-label={t(($) => $.smart.toggle_aria)} className="flex shrink-0 rounded-md border p-0.5">
      {(["smart", "classic"] as const).map((m) => (
        <Button
          key={m}
          size="xs"
          variant={mode === m ? "secondary" : "ghost"}
          aria-pressed={mode === m}
          // 44px tap target on phones; compact in the desktop header.
          className="min-h-11 md:min-h-0"
          onClick={() => onChange(m)}
        >
          {m === "smart" ? t(($) => $.smart.smart) : t(($) => $.smart.classic)}
        </Button>
      ))}
    </div>
  );
}

export function InboxEntryPage() {
  const enabledForUser = useAuthStore((s) => s.user?.smart_inbox === true);
  const [mode, setMode] = useSmartInboxMode();
  const { searchParams } = useNavigation();
  const archived = searchParams.get("view") === ARCHIVED_VIEW_PARAM;
  const isCompact = useIsCompact();

  if (!enabledForUser) return <ClassicInboxPage />;
  const toggle = <InboxModeToggle mode={mode} onChange={setMode} />;
  if (mode === "classic") return <ClassicInboxPage headerAccessory={toggle} />;
  // Phones: the single-column list -> focused detail -> back flow. The archive
  // sub-view only exists in the classic layout.
  if (isCompact && !archived) return <SmartInboxPage headerAccessory={toggle} />;
  // Tablet and up: Classic's two panes with Smart's sections and signal briefs.
  return <ClassicInboxPage headerAccessory={toggle} smart />;
}
