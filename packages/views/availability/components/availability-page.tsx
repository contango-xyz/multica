"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays } from "@multica/ui/icons";
import type { MemberAvailability, TimeOffEntry } from "@multica/core/types";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  availabilityOptions,
  useAddMyTimeOff,
  useDeleteMyTimeOff,
  useUpdateMyAvailability,
} from "@multica/core/availability/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Switch } from "@multica/ui/components/ui/switch";
import { CollectionPageHeader, CollectionPageState } from "../../layout/collection-page";
import { useT } from "../../i18n";

// Who works when and who is away (Contango fork, patch 38): one row per person, their working hours
// and their time off for the next 30 days, plus the viewer's own time off, backup and calendar link.

/** "Europe/London|Mon-Fri|09:00-18:00" -> "Mon-Fri 09:00-18:00 (Europe/London)". */
export function formatWorkHours(v: string): string {
  const [zone, days, hours] = v.split("|");
  return zone && days && hours ? `${days} ${hours} (${zone})` : "";
}

/** "2026-11-16".."2026-11-20" -> "16 Nov – 20 Nov"; one day shows once. */
export function formatRange(e: Pick<TimeOffEntry, "starts_on" | "ends_on">): string {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return e.starts_on === e.ends_on ? fmt(e.starts_on) : `${fmt(e.starts_on)} – ${fmt(e.ends_on)}`;
}

export function AvailabilityPage() {
  const { t } = useT("layout");
  const wsId = useWorkspaceId();
  const me = useAuthStore((s) => s.user?.id);
  const { data, isLoading } = useQuery(availabilityOptions(wsId));
  const members = (data?.members ?? []).filter((m) => m.email !== "multica-bot@contango.xyz");
  const mine = members.find((m) => m.user_id === me);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader icon={CalendarDays} title={t(($) => $.availability.page_title)} />
      {isLoading ? (
        <CollectionPageState icon={CalendarDays} title={t(($) => $.availability.page_title)} />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-4 space-y-8">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">{t(($) => $.availability.person)}</th>
                <th className="py-2 pr-4 font-medium">{t(($) => $.availability.hours)}</th>
                <th className="py-2 pr-4 font-medium">{t(($) => $.availability.today)}</th>
                <th className="py-2 font-medium">{t(($) => $.availability.upcoming)}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <PersonRow key={m.user_id} member={m} />
              ))}
            </tbody>
          </table>
          {mine && <MySection me={mine} members={members} wsId={wsId} />}
        </div>
      )}
    </div>
  );
}

function PersonRow({ member }: { member: MemberAvailability }) {
  const { t } = useT("layout");
  return (
    <tr className="border-t border-border align-top">
      <td className="py-2 pr-4">{member.name || member.email}</td>
      <td className="py-2 pr-4">{formatWorkHours(member.work_hours) || t(($) => $.availability.not_set)}</td>
      <td className="py-2 pr-4">
        {member.away_today ? t(($) => $.availability.away) : t(($) => $.availability.working)}
      </td>
      <td className="py-2">
        {member.time_off.length === 0
          ? "—"
          : member.time_off.map((e) => (
              <div key={e.id}>
                {formatRange(e)}
                {e.half_day ? ` (${t(($) => $.availability.half_day)})` : ""}
                {e.label ? ` · ${e.label}` : ""}
              </div>
            ))}
      </td>
    </tr>
  );
}

function MySection({ me, members, wsId }: { me: MemberAvailability; members: MemberAvailability[]; wsId: string }) {
  const { t } = useT("layout");
  const add = useAddMyTimeOff(wsId);
  const remove = useDeleteMyTimeOff(wsId);
  const update = useUpdateMyAvailability(wsId);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [halfDay, setHalfDay] = useState(false);
  const [note, setNote] = useState("");
  const [ical, setIcal] = useState("");
  const sourceLabel = (s: string) =>
    s === "shared-ical"
      ? t(($) => $.availability.source_shared)
      : s === "personal-ical"
        ? t(($) => $.availability.source_personal)
        : t(($) => $.availability.source_manual);

  return (
    <section className="space-y-4">
      <h2 className="font-medium">{t(($) => $.availability.mine)}</h2>
      <ul className="space-y-1 text-sm">
        {me.time_off.map((e) => (
          <li key={e.id} className="flex items-center gap-3">
            <span>
              {formatRange(e)}
              {e.half_day ? ` (${t(($) => $.availability.half_day)})` : ""}
              {e.label ? ` · ${e.label}` : ""}
            </span>
            <span className="text-muted-foreground">{sourceLabel(e.source)}</span>
            {e.source === "manual" && (
              <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(e.id)}>
                {t(($) => $.availability.remove)}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="space-y-1">
          <div>{t(($) => $.availability.from)}</div>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="space-y-1">
          <div>{t(($) => $.availability.to)}</div>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 pb-2">
          <Switch checked={halfDay} onCheckedChange={setHalfDay} />
          {t(($) => $.availability.half_day)}
        </label>
        <label className="space-y-1">
          <div>{t(($) => $.availability.note)}</div>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button
          disabled={!from || add.isPending}
          onClick={() =>
            add.mutate(
              { starts_on: from, ends_on: to || from, half_day: halfDay, label: note },
              {
                onSuccess: () => {
                  setFrom("");
                  setTo("");
                  setHalfDay(false);
                  setNote("");
                },
              },
            )
          }
        >
          {t(($) => $.availability.add)}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="space-y-1">
          <div>{t(($) => $.availability.backup)}</div>
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2"
            value={me.backup_user_id ?? ""}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ backup_user_id: e.target.value })}
          >
            <option value="">{t(($) => $.availability.none)}</option>
            {members
              .filter((m) => m.user_id !== me.user_id)
              .map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name || m.email}
                </option>
              ))}
          </select>
        </label>
        <label className="space-y-1 min-w-80">
          <div>
            {t(($) => $.availability.ical)}
            {me.personal_ical ? ` · ${t(($) => $.availability.ical_connected)}` : ""}
          </div>
          <Input type="password" autoComplete="off" value={ical} onChange={(e) => setIcal(e.target.value)} />
        </label>
        <Button
          variant="outline"
          disabled={!ical || update.isPending}
          onClick={() => update.mutate({ personal_ical_url: ical }, { onSuccess: () => setIcal("") })}
        >
          {t(($) => $.availability.save)}
        </Button>
      </div>
    </section>
  );
}
