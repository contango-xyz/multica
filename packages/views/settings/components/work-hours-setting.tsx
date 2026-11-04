"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { notificationPreferenceOptions } from "@multica/core/notification-preferences/queries";
import {
  WEEKDAYS,
  formatWorkHours,
  parseWorkHours,
  useUpdateWorkHours,
  type Weekday,
  type WorkHours,
} from "@multica/core/notification-preferences/work-hours";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { SettingsCard, SettingsRow } from "./settings-layout";

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function zones(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  return Array.from(new Set(["UTC", current, ...all])).sort();
}

const FALLBACK: Omit<WorkHours, "zone"> = { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], from: "09:00", to: "18:00" };

/**
 * Working hours (contango): the ops inbox feeder sends its periodic "asks
 * waiting on you" reminders only inside this window. New asks still notify at
 * once; this only quiets the reminders.
 */
export function WorkHoursSetting() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const { data } = useQuery(notificationPreferenceOptions(wsId));
  const saved = parseWorkHours(data?.preferences?.work_hours);
  const mutation = useUpdateWorkHours();
  const [draft, setDraft] = useState<WorkHours | null>(null);

  // The form starts from the saved value, else the browser's zone and a weekday default.
  useEffect(() => {
    setDraft(saved ?? { zone: browserZone(), ...FALLBACK });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.preferences?.work_hours]);
  const zoneList = useMemo(() => zones(draft?.zone ?? "UTC"), [draft?.zone]);
  if (!draft) return null;

  const toggleDay = (d: Weekday) =>
    setDraft({ ...draft, days: WEEKDAYS.filter((x) => (x === d ? !draft.days.includes(d) : draft.days.includes(x))) });
  const valid = draft.days.length > 0 && /^\d\d:\d\d$/.test(draft.from) && /^\d\d:\d\d$/.test(draft.to) && draft.from !== draft.to;
  const dirty = !saved || formatWorkHours(saved) !== formatWorkHours(draft);
  const save = (value: string) =>
    mutation.mutate(value, {
      onSuccess: () => toast.success(t(($) => $.notifications.work_hours.saved)),
      onError: (err) =>
        toast.error(err instanceof Error && err.message ? err.message : t(($) => $.notifications.toast_failed)),
    });

  return (
    <SettingsCard>
      <SettingsRow
        anchor="work_hours"
        align="start"
        label={t(($) => $.notifications.work_hours.label)}
        description={
          saved
            ? t(($) => $.notifications.work_hours.description)
            : t(($) => $.notifications.work_hours.not_set)
        }
      >
        <div className="flex flex-col gap-2">
          <select
            aria-label={t(($) => $.notifications.work_hours.zone)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={draft.zone}
            onChange={(e) => setDraft({ ...draft, zone: e.target.value })}
          >
            {zoneList.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t(($) => $.notifications.work_hours.days)}>
            {WEEKDAYS.map((d) => (
              <Button
                key={d}
                type="button"
                size="sm"
                variant={draft.days.includes(d) ? "default" : "outline"}
                aria-pressed={draft.days.includes(d)}
                onClick={() => toggleDay(d)}
              >
                {d}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="time"
              className="h-8 w-28"
              aria-label={t(($) => $.notifications.work_hours.from)}
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
            <span className="text-muted-foreground text-sm">–</span>
            <Input
              type="time"
              className="h-8 w-28"
              aria-label={t(($) => $.notifications.work_hours.to)}
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={!valid || !dirty || mutation.isPending} onClick={() => save(formatWorkHours(draft))}>
              {t(($) => $.notifications.work_hours.save)}
            </Button>
            {saved && (
              <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => save("")}>
                {t(($) => $.notifications.work_hours.clear)}
              </Button>
            )}
          </div>
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}
