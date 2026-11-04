import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { notificationPreferenceKeys } from "./queries";
import type { NotificationPreferenceResponse } from "../types";

/**
 * Working hours (contango): "<IANA zone>|<days>|<HH:MM-HH:MM>", e.g.
 * "Europe/London|Mon,Tue,Wed,Thu,Fri|09:00-18:00". The ops inbox feeder sends
 * its "asks waiting on you" reminders only inside this window.
 */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WorkHours {
  zone: string;
  days: Weekday[];
  from: string;
  to: string;
}

export function parseWorkHours(value: string | undefined): WorkHours | null {
  const parts = (value ?? "").split("|");
  if (parts.length !== 3) return null;
  const [zone, rawDays, rawHours] = parts as [string, string, string];
  const days = new Set<Weekday>();
  for (const part of rawDays.split(",")) {
    const [a, b] = part.split("-");
    const i = WEEKDAYS.indexOf(a as Weekday);
    const j = b ? WEEKDAYS.indexOf(b as Weekday) : i;
    if (i < 0 || j < 0) return null;
    for (let k = i; ; k = (k + 1) % 7) {
      days.add(WEEKDAYS[k]!);
      if (k === j) break;
    }
  }
  const [from, to] = rawHours.split("-");
  if (!from || !to) return null;
  return { zone, days: WEEKDAYS.filter((d) => days.has(d)), from, to };
}

export function formatWorkHours(w: WorkHours): string {
  return `${w.zone}|${w.days.join(",")}|${w.from}-${w.to}`;
}

/** Save ("" clears) only the work_hours key, through the atomic PATCH endpoint. */
export function useUpdateWorkHours() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (value: string) => api.updateNotificationPreferences({ work_hours: value }),
    onSuccess: (response) => {
      qc.setQueryData<NotificationPreferenceResponse>(notificationPreferenceKeys.all(wsId), response);
    },
  });
}
