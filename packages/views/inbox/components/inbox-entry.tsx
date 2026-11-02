"use client";

// Chooses between the classic inbox and the contango smart inbox
// (docs/contango/SMART-INBOX.md). The smart view needs both the server flag
// for the current user (`user.smart_inbox`) and a client opt-in: the URL once
// carried `?smart-inbox=1` (remembered; `?smart-inbox=0` forgets it). Anything
// else renders the classic page unchanged.

import { useEffect, useState } from "react";
import { useAuthStore } from "@multica/core/auth";
import {
  SMART_INBOX_URL_PARAM,
  smartInboxModeFromParam,
  type SmartInboxMode,
} from "@multica/core/inbox/smart";
import { Button } from "@multica/ui/components/ui/button";
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

export function useSmartInboxMode(): [SmartInboxMode | null, (m: SmartInboxMode) => void] {
  const { searchParams } = useNavigation();
  const param = searchParams.get(SMART_INBOX_URL_PARAM);
  const [mode, setMode] = useState<SmartInboxMode | null>(() =>
    smartInboxModeFromParam(param, readStoredMode()),
  );
  useEffect(() => {
    const next = smartInboxModeFromParam(param, readStoredMode());
    writeStoredMode(next);
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

  if (!enabledForUser || !mode) return <ClassicInboxPage />;
  const toggle = <InboxModeToggle mode={mode} onChange={setMode} />;
  // The archive sub-view only exists in the classic layout.
  if (mode === "smart" && !archived) return <SmartInboxPage headerAccessory={toggle} />;
  return <ClassicInboxPage headerAccessory={toggle} />;
}
