// Inbox tabs' Squad screen (contango patch 43, docs/contango/SMART-INBOX.md
// "Tabs"): GET /api/inbox/squad. The snapshot is the ops feeder's cut of the
// capacity report (team/bottleneck.py's bottleneck.json); every field is
// optional so a report change degrades to a smaller screen, never an error.

import { z } from "zod";

const num = z.number().catch(0);

const SquadBucketSchema = z.object({ hours: num, share: num }).loose();

const SquadPersonSchema = z
  .object({ name: z.string().catch(""), hours: num, via_blocked_hours: num.optional() })
  .loose();

const SquadHoldSchema = z
  .object({
    key: z.string().catch(""),
    title: z.string().catch(""),
    human: z.string().catch(""),
    hours: num,
    cards: z.array(z.unknown()).catch([]),
  })
  .loose();

// Patch 51 (owner 2026-11-17): the MVP driver's "who is blocking what", per
// person with an open ask: asks, the open MVP cards those asks hold up
// (distinct), and the oldest ask's wait in hours. The feeder adds it to the
// snapshot (mvp_holds), so it shows on the Squad tab instead of a Today card.
const MvpHoldSchema = z
  .object({ user_id: z.string().catch(""), name: z.string().catch(""), asks: num, mvp: num, oldest_h: num })
  .loose();

export const SquadSnapshotSchema = z
  .object({
    generated_at: z.string().nullish().catch(null),
    window_hours: num.optional(),
    card_hours: num.optional(),
    buckets: z.record(z.string(), SquadBucketSchema).catch({}),
    people: z.array(SquadPersonSchema).catch([]),
    people_via_blocked: z.array(SquadHoldSchema).catch([]),
    mvp_holds: z.array(MvpHoldSchema).catch([]).optional(),
  })
  .loose();

const InboxLoadSchema = z
  .object({
    user_id: z.string().catch(""),
    name: z.string().catch(""),
    decisions: num,
    merges: num,
    everything_else: num,
    new_asks_7d: num,
  })
  .loose();

export const InboxSquadSchema = z.object({
  snapshot: SquadSnapshotSchema.nullable().catch(null),
  received_at: z.string().nullish().catch(null),
  inbox_load: z.array(InboxLoadSchema).catch([]),
});

export type InboxSquad = z.infer<typeof InboxSquadSchema>;
export type SquadSnapshot = z.infer<typeof SquadSnapshotSchema>;
export type InboxLoad = z.infer<typeof InboxLoadSchema>;
export type MvpHold = z.infer<typeof MvpHoldSchema>;

export const EMPTY_INBOX_SQUAD: InboxSquad = { snapshot: null, received_at: null, inbox_load: [] };

/** The capacity report's buckets, in the order the screen shows them. */
export const SQUAD_BUCKETS = ["people", "blocked", "machines", "working", "nobody", "subs", "seats"] as const;

/**
 * The Squad tab's inbox load joined with the MVP holds (patch 51), most MVP
 * cards held first, then most open decisions and merges. A person with no
 * open ask has `mvp: null`.
 */
export function squadLoadRows(data: InboxSquad): (InboxLoad & { mvp: MvpHold | null })[] {
  const holds = new Map((data.snapshot?.mvp_holds ?? []).map((h) => [h.user_id, h]));
  return data.inbox_load
    .map((r) => ({ ...r, mvp: holds.get(r.user_id) ?? null }))
    .sort(
      (a, b) =>
        (b.mvp?.mvp ?? 0) - (a.mvp?.mvp ?? 0) ||
        b.decisions + b.merges - (a.decisions + a.merges) ||
        (b.mvp?.oldest_h ?? 0) - (a.mvp?.oldest_h ?? 0),
    );
}
