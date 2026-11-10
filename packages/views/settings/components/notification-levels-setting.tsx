"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { notificationPreferenceOptions } from "@multica/core/notification-preferences/queries";
import { useUpdateNotificationPreferences } from "@multica/core/notification-preferences/mutations";
import type { NotificationLevel, NotificationPreferences } from "@multica/core/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { SettingsCard, SettingsRow } from "./settings-layout";

const LEVELS: NotificationLevel[] = ["low", "normal", "high", "critical"];
const MINIMUMS: (NotificationLevel | "off")[] = ["low", "normal", "high", "critical", "off"];

// Notification levels (contango patch 39): each category has a level; each person picks the lowest level that
// pushes to their phone and pops up on their desktop. The inbox itself always shows everything.
export function NotificationLevelsSetting() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const { data } = useQuery(notificationPreferenceOptions(wsId));
  const mutation = useUpdateNotificationPreferences();
  const preferences: NotificationPreferences = data?.preferences ?? {};
  const categories = data?.categories ?? [];

  const levelLabel = (l: NotificationLevel | "off") => t(($) => $.notifications.levels.names[l]);

  const save = (key: string, value: string, defaultValue: string) => {
    const updated: Record<string, string> = { ...(preferences as Record<string, string>) };
    if (value === defaultValue) delete updated[key];
    else updated[key] = value;
    mutation.mutate(updated as NotificationPreferences, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message ? err.message : t(($) => $.notifications.toast_failed),
        ),
    });
  };

  const minimum = (key: "push_min_mobile" | "push_min_desktop", label: string) => {
    const value = (preferences as Record<string, string>)[key] ?? "low";
    return (
      <SettingsRow anchor={key} label={label}>
        <Select
          items={MINIMUMS.map((l) => ({ value: l, label: levelLabel(l) }))}
          value={value}
          onValueChange={(v) => save(key, String(v), "low")}
        >
          <SelectTrigger className="w-40" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MINIMUMS.map((l) => (
              <SelectItem key={l} value={l}>
                {levelLabel(l)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    );
  };

  return (
    <>
      <SettingsCard>
        {minimum("push_min_mobile", t(($) => $.notifications.levels.phone))}
        {minimum("push_min_desktop", t(($) => $.notifications.levels.desktop))}
      </SettingsCard>
      {categories.length > 0 && (
        <SettingsCard>
          {categories.map((c) => {
            const key = `level_${c.key}`;
            const value = (preferences as Record<string, string>)[key] ?? c.default;
            return (
              <SettingsRow key={c.key} anchor={key} label={c.label}>
                <Select
                  items={LEVELS.map((l) => ({ value: l, label: levelLabel(l) }))}
                  value={value}
                  onValueChange={(v) => save(key, String(v), c.default)}
                >
                  <SelectTrigger className="w-40" aria-label={c.label}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((l) => (
                      <SelectItem key={l} value={l}>
                        {levelLabel(l)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
            );
          })}
        </SettingsCard>
      )}
    </>
  );
}
