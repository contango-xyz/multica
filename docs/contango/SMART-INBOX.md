# Smart inbox (contango, owner request 2026-11-02)

## What the owner asked for (summary)
- One inbox that is the central control board, replacing most task-related Slack notifications (Slack stays only as an escalation fallback).
- Prioritised by ticket importance, grouped by type (merge asks, approvals/decisions, access/funding, stalled work, alerts, FYI), with entries for things that need you even when nobody tagged you (stalled, waiting on you, blocking others).
- For **every human** in the workspace, not just the owner.
- **Mobile friendly**: today an entry points at a tagged comment in a long issue thread, which is unusable on a phone. Each entry must carry what you need to act: what is asked, why it ranks there, one action.
- Refactor the existing inbox, not a new screen: a **Smart / Classic** toggle over the same entries.
- **Feature flagged**: most people use the desktop app; nobody must get notifications for entry kinds their client can't show. Server-side: new kinds of entries (and their pushes) are created only for allowlisted members. Web: the smart view shows only with `?smart-inbox=1` (remembered; `?smart-inbox=0` turns it off). When the owner is happy, desktop + iOS + flag go out together.

## Decisions taken (owner away; simple calls made by the operator)
1. **Split:** the fork gets a generic "signal" mechanism (types, an upsert/resolve API, push, the smart view, the flag). Contango's policy (who is waiting on whom, what is stalled, how important) lives in an ops job in claude-sandbox that feeds signals through that API, reusing the doorbell/stall-watch logic. This keeps the fork patch generic and small.
2. **Ranking is computed in the client** from fields on the entry (priority, blocks, waiting since), so entries age and climb without the server rewriting them.
3. **Signals resolve themselves:** the feeder resolves (archives) a signal as soon as its condition is gone; a re-raise after a long wait updates the same entry (same key) and pushes again.
4. **Flag:** server env `MULTICA_SMART_INBOX_EMAILS` (comma-separated, initially the owner only). Signal API calls for anyone else are accepted and ignored (204) so the feeder needs no flag logic of its own. Web: URL param as above, plus the server's public config saying the flag exists for this user.

## Contract between the fork and the feeder
`POST /api/inbox/signals` (workspace owner/admin, or the bot member): upsert.
```json
{ "recipient_member_id": "uuid", "key": "needs-human:CTG-1718:<comment-id>", "group": "merge|decision|access|stalled|blocking|alert|fyi",
  "severity": "action_required|attention|info", "issue_id": "uuid|null",
  "title": "Approve merge #3204",                       // line 1: what you need to do (<= 60 chars)
  "summary": "CTG-1718 · blocks 3 cards · waiting 6 h",  // line 2: why it's here
  "body": "short self-contained context (<= 600 chars, markdown-lite)",
  "actions": [{"label": "Open PR", "url": "https://github.com/..."}],
  "rank": {"priority": "urgent|high|medium|low|none", "blocks": 3, "since": "RFC3339"},
  "push": true }
```
- Same (workspace, recipient, key) while not archived: update in place; push again only when the request says `"push": true` and the title or summary changed (re-raise).
- `POST /api/inbox/signals/resolve` `{ "recipient_member_id", "key" }`: archive it (no push). Unknown key: 204.
- New inbox item type `signal` with `details` = {group, summary, actions, rank, key}. Pushes for it respect the recipient's inbox notification settings (a new per-group toggle; default on for action_required groups, off for fyi).

### As built (fork patch 14; differences from and additions to the contract above)
- **Recipient:** `recipient_member_id` is the recipient's **user id** (what `inbox_item.recipient_id`
  stores, and what the "Responsible human" property holds). A `member` row id is also accepted as a
  fallback. Either way the user must be a member of the workspace (else 400). The flag is checked
  against that user's email.
- **Auth:** workspace `owner`/`admin` (`RequireWorkspaceRole`), human credentials only: a personal
  access token (`mul_…`, what the feeder/bot uses) or a session. Agent task tokens and cloud-node
  tokens get 403 even when their owner is an admin. Workspace via `X-Workspace-ID` / `X-Workspace-Slug`.
- **Responses:** upsert → 201 (created) / 200 (updated) with `{item, created, pushed}`; resolve → 200
  `{item}`, or 204 for an unknown/already resolved key. Flag off for the recipient → 204 on both,
  nothing stored. Validation errors → 400 (checked before the flag, so feeder bugs show up).
- **Validation / defaults:** `key` 1–200 chars; `title` 1–60; `summary` ≤ 140; `body` ≤ 600 (stored
  as plain text, rendered as plain text with line breaks); ≤ 3 `actions`, label 1–40, absolute
  `http(s)` URL ≤ 2000; `group` enum; `severity` defaults to `attention`; `rank.priority` defaults to
  `none`; `rank.blocks` 0–10000; `rank.since` RFC3339, defaults to the previous value on update, else
  now. `issue_id` must be an issue in the workspace. `push` omitted = true on create.
- **Pushes:** create pushes unless `push:false`; update pushes only with `push:true` and a changed
  title or summary (a **re-raise**, which also marks the entry unread, un-archives it and moves it to
  the top: `created_at` = now). Push text: title + summary. Then the recipient's per-group setting
  `signal_<group>` (`all`/`muted`, same preferences endpoint as the other groups) decides; default on,
  `fyi` default off. The system-notifications mute still applies. A signal that doesn't push is still
  stored and shown; clients get `inbox:updated` (refetch, no banner) instead of `inbox:new`.
- **Dismissed signals stay quiet:** the live key is found whether or not the user archived the entry
  (a user can archive a signal, or archive its issue group in Classic). Updates to an archived signal
  are silent and keep it archived; only a re-raise brings it back. Resolve stamps
  `details.resolved_at` and archives, which frees the key: the next upsert creates a new entry. This
  differs from "while not archived" above, which would re-create and re-push a dismissed signal on
  every feeder pass.
- **Migration:** `607_inbox_signal_key_index` (unique partial index on
  `(workspace_id, recipient_id, details->>'key')` for unresolved signals; no new column).
- **Client flag:** `GET /api/me` returns `smart_inbox: true` for users on the list (omitted otherwise).

## Smart view (web, flagged)
- **Waiting on you** first: action_required signals plus mention/review entries addressed to you, ranked by priority weight × blocks × age; each row shows the rank reason.
- Then sections per group (merge approvals, decisions, access & funding, stalled, blocking others, alerts, everything else as FYI), collapsed when empty.
- Each row: line 1 title, line 2 summary, one primary action button; tap opens a focused detail (body + actions + a link to the issue), not the thread.
- Existing entries (mentions etc.) show the comment preview as line 2 and "Open issue" as the action.
- Works at phone width (one column, 44 px tap targets, no horizontal scroll).
- Smart/Classic toggle in the inbox header.

As built: the view is used when `user.smart_inbox` is true and the browser has opted in
(`?smart-inbox=1` → localStorage `multica:smart-inbox` = `smart`; the toggle stores `smart` /
`classic`; `?smart-inbox=0` removes it). The Archived sub-view always uses Classic. Ranking score =
priority weight (urgent 8, high 4, medium 2, low/none 1) × (1 + blocks) × age in hours (floor 0.1),
recomputed every minute; non-signal entries use the issue priority and their own age. Signals are one
row each; other entries are grouped per issue like Classic.

**Classic++ (third revision, 2026-11-02, owner: "it should look like classic++"):** from 1024 px up
(Classic's own two-pane breakpoint) Smart IS the Classic page: list on the left, the selected item's
detail on the right, selection only rewrites `?issue=` on the same route. The list is Smart's sections
(below) over Classic's own rows (`InboxListItem`): avatar of whoever poked you (system mark for a
signal-only row), status icon, agent-working badge, unread dot, time, title; a signal row's line 2 is
its summary (the section header already names the group) and a needs-you row gets the amber bar. The
right pane is Classic's detail; for a signal, a compact brief (ask, summary, reason, body, action
buttons) sits above the issue thread, so nothing is lost; a mention's pane is exactly Classic's. The
header is Classic's (filters, bulk menu, archive entry) plus the group filter and the Smart/Classic
toggle as one icon button. A signal and a mention on the same issue are separate rows: signals key
on their own id (`inboxRowKey`), other rows on their issue as before. The archived view stays Classic.
Below 1024 px the single-column flow described next is unchanged (list → focused detail → back).

**Dashboard (fourth revision, 2026-11-02, owner: "a mixture of an inbox with a dashboard/control
panel"):** above the two panes (phones: above the sections) the Smart view shows:
- **Do this first:** the top 3 entries waiting on you (action_required signals, mentions, review
  requests) by rank score, numbered 1-3, each with its one action (the signal's first action, else
  Open) and the reason in plain words ("urgent · blocks 4 cards · waiting 9h"). Computed from the live
  list, so clearing one promotes the next; "Nothing waiting on you" when empty.
- **Counters:** waiting on you, per group, the oldest wait (amber over 4 h, red over 24 h; click
  opens it) and the urgent count. Each filters the list (waiting → "Needs my action only", a group →
  that group alone, again to clear; urgent → "Urgent only", also in the group filter menu).
- **Squad health:** only from the reader's own signals: each `alert` signal as a red chip by its title
  (e.g. "main red"), and the stalled / blocking counts. Nothing is shown without such signals; no other
  source is read.
- Phones get Do this first plus one counters line ("3 waiting on you · oldest 9h · 1 urgent").
- **Rows** in Smart get a priority badge (urgent red, high orange) and an age tint on the time (amber
  after 4 h, red after 24 h; urgent after 1 h and 4 h); for signals the time is the wait (rank.since).

**Layout (revised 2026-11-02 after the owner's first look):** one section per kind — Merge approvals,
Decisions, Access & funding, Stalled, Blocking others, Alerts (the signal groups), Mentions & reviews
(`mentioned` / `review_requested` entries) and FYI (fyi signals and every other entry). There is no
single "Waiting on you" bucket any more. Each section ranks its entries by score (FYI: newest first);
sections are ordered by their top entry's score, FYI always last; empty sections are hidden. A section
header shows its label, count and its top entry's reason ("Urgent · blocks 3 · 6h"), plus a menu with
**Mark read** and **Archive all** for that section. Entries that need you (`action_required` signals,
mentions, review requests) carry an amber bar and a bold title. On phone widths a section header folds
the section, and a section shows its top 3 rows with "Show N more".

Rows: line 1 title + age (from `sm` up, the full reason in ranked sections), line 2 summary or comment
preview, one action (the signal's first action as an external link, else "Open"/"Open issue"), and an
archive button (on hover/focus with a mouse; always shown, muted, on touch). Tapping opens a focused
detail (summary, reason, body, all actions, Open issue, Archive) and marks it read.

**Header:** the same tools as Classic — the classic filter menu (status, priority, from, unread only,
no agents working) applied to the same entries, and the bulk menu (mark all read, archive all, archive
all read, archive completed) — plus a **group filter** (multi-select sections, and "Needs my action
only"). Smart filters live per workspace in memory, like the classic ones. Filtering by project was
left out: inbox entries don't carry the project, so it would need an issue lookup per entry.

**Sender in Classic:** signals show the Multica system mark named after their group, never a person.
Signals used to be stored without an actor, and the classic row fell back to the recipient's own
avatar, so every signal looked like it came from the reader. The server now writes
`actor_type = 'system'` on insert and on every update (old rows heal on the feeder's next pass), and
the classic row ignores the actor for type `signal`, so old rows render correctly either way.

**Issue groups in Classic (fix 2026-11-02, second round):** Classic shows one row per issue. That row
used to be the issue's newest entry, and the feeder refreshes a signal on exactly the issues where an
agent tagged you, so those rows showed the system sender instead of the agent. Now a group SHOWS its
newest non-signal entry (sender, title, preview, time) whenever it has one; a signal-only group shows
the signal, with the system mark and its group label as line 2 ("Stalled · no update for 6 h"). In the
active list the group keeps the newest row's id and read/archived state, so opening, read/unread and
archive act on the group exactly as before (client grouping in `packages/core/inbox/queries.ts`). The
Archived list, grouped server-side, uses the newest non-signal row as the group's representative
(`ListArchivedInboxPage`, `ArchivedInboxFacets`, `ListArchivedInboxItems`), so the From filter matches
the shown sender. Smart is unaffected: it takes signals one by one from the raw list and groups only
the other entries.

Desktop and mobile apps are unchanged (classic only; the desktop shares the web view code but never
sees the opt-in param). Classic rows show a signal's summary as their second line.

## What the feeder produces (ops job, every 2 min)
- **merge / decision / access**: each open `[NEEDS HUMAN]` ask (needs-human set) → its Responsible human; group from the ask's text (merge ask, plan/design approval, login/access/funding, other decision). Also a merge-ready PR whose approval is owned by that human (pr-watch's merge asks).
- **stalled**: stall-watch's stalled cards → the card's Responsible human.
- **blocking**: a card the human is responsible for that blocks N ≥ 2 open cards and is itself waiting on them.
- **alert** (owner only at first): main red, CD red, spend alert.
- Re-raise: a waiting entry older than 4 h (urgent: 1 h) gets its summary refreshed with push.
- Resolve: when the ask is answered, Needs human cleared, card done, PR merged, stall gone.
