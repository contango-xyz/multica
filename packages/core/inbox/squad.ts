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

export const SquadSnapshotSchema = z
  .object({
    generated_at: z.string().nullish().catch(null),
    window_hours: num.optional(),
    card_hours: num.optional(),
    buckets: z.record(z.string(), SquadBucketSchema).catch({}),
    people: z.array(SquadPersonSchema).catch([]),
    people_via_blocked: z.array(SquadHoldSchema).catch([]),
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

export const EMPTY_INBOX_SQUAD: InboxSquad = { snapshot: null, received_at: null, inbox_load: [] };

/** The capacity report's buckets, in the order the screen shows them. */
export const SQUAD_BUCKETS = ["people", "blocked", "machines", "working", "nobody", "subs", "seats"] as const;
