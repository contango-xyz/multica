# MVP page (patch 19)

Owner, 2026-11-06: "the management of what MVP means, how close we are, critical path(s), and all related
bullshit needs a UI, ideally inside multica (so we can add agent questions)". The page is `/{workspace}/mvp`
(Work panel, under Dependencies; web only, like the dependency graph). It is read-only: the definition, the
scope and the answers all live on cards, and the page reads them.

## What it shows

1. **What MVP means:** the description of the MVP home card (`MULTICA_MVP_HOME_ISSUE`), rendered as Markdown,
   with "Edit / discuss" linking to the card. The definition is edited on that card, and questions about it
   are asked and answered in its thread.
2. **Headline numbers:** % done, open cards, cards done in the last 7 days, projected finish.
3. **Burndown:** open and done MVP cards per day for the last 30 days, and a projection: open ÷ (cards done
   in the last 7 or 14 days ÷ 7 or 14). It is labelled a projection: it ignores new scope and blockers.
4. **Critical path:** up to three longest chains of open work through "blocked by" edges (patch 9) that end
   at an open MVP card, first blocker first. Their cards are outlined everywhere else on the page.
5. **What's in the way:** open human asks on MVP cards, grouped by the person they are for, with how many MVP
   cards each person holds (the asked cards plus every open MVP card waiting on them through "blocked by").
   When the smart inbox (patch 14) raised an entry for the ask and it carries one-tap replies (patch 18), its
   recipient sees the same reply buttons here. Next to it: MVP cards that are Held, Blocked with no open
   blocker, or started but without an agent run for 24 h.
6. **Agent questions:** the open `[NEEDS HUMAN]` / `[NEEDS OPERATOR]` asks on the home card and on the pillar
   epics, linking into the thread. Agents add a question by asking on one of those cards.
7. **Pillars:** each top-level MVP epic with its done/total, a progress bar, open cards per status, and an
   expandable list of its open cards (status, assignee, Responsible human, blockers, cards waiting on it).
   Top-level MVP cards with no sub-cards are one "Cards without an epic" group; finished pillars fold away.

## Definitions

- **Scope:** an issue tagged with the Release option `MVP`, or untagged under an in-scope parent. A subtree
  tagged with another release (Post-MVP, Internal...) is out, unless a card in it is tagged MVP itself. The
  home card is never in scope.
- **Counted cards are leaves:** cards with no in-scope sub-cards. An epic and its cards are not counted twice.
- **Open / done:** by the status's category (unstarted and started are open; done is done). Cancelled
  (closed) cards are left out of every total.
- **Pillar:** an in-scope issue with in-scope sub-cards and no in-scope parent.
- **Open ask:** the card's latest `[NEEDS HUMAN]` comment (or `[NEEDS OPERATOR]` for agent questions) with no
  later comment from a person (bot members in `MULTICA_BOT_USER_IDS` and `PR_WATCH:` prompts do not count;
  for operator asks an "Operator note" reply counts). "Waiting on people" also needs the card's Needs human
  flag, as the smart-inbox feeder does.
- **Whom an ask is for:** the smart-inbox entry's recipient when there is one (that is the feeder's routing,
  tech owners included); otherwise the last member the ask @mentions, else the card's Responsible human, else
  its parent's, else its member creator.

## How history is rebuilt (and its limits)

The burndown uses the `status_changed` rows of `activity_log` (`details.from` / `details.to`) since the window
start. A card's status at time T is the `from` of its first change after T, or its current status when it has
none; a card created after T is not counted. Limits:

- Scope is today's: a card tagged MVP last week counts in every past day it existed, and a card moved out of
  MVP is gone from the history. Rising "done" lines partly reflect cards tagged MVP after they were finished.
- Parent links and leaf status are also today's.
- A status change that did not write an activity is invisible: on 2026-11-06, 99% of cards' latest
  `status_changed` matched their current status.

## API

`GET /api/mvp` (any workspace member, agents included). One response with `configured`, `problem`, `config`,
`home`, `totals`, `pillars`, `standalone`, `critical_paths`, `burndown`, `eta`, `humans`, `stuck`,
`agent_questions`; the shapes are `server/internal/mvp/mvp.go` and `packages/core/types/api.ts` (`MvpReport`).
Computed per request from about eight indexed queries (issues, statuses, members, properties, edges, runs,
the window's status changes, the asks and signals of the flagged and pillar cards) plus in-memory work; an estimated
0.1 s on production data (0.4 s measured end to end over an SSH tunnel, where each query pays a round trip). There is no CLI command for it yet: an agent
reads it with an authenticated `GET` (its token, `X-Workspace-ID`).

## Config (backend env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MULTICA_MVP_HOME_ISSUE` | unset | The definition card, `CTG-2386` or `2386`. Unset: no definition section. |
| `MULTICA_MVP_RELEASE_PROPERTY` | `Release` | Select property that says the release. |
| `MULTICA_MVP_RELEASE_OPTION` | `MVP` | Its option that means MVP. |
| `MULTICA_MVP_RESPONSIBLE_PROPERTY` | `Responsible human` | Actor property naming the card's human. |
| `MULTICA_MVP_NEEDS_HUMAN_PROPERTY` | `Needs human` | Checkbox flag of a card waiting on a person. |
| `MULTICA_MVP_HELD_STATUS` | `held` | Status key counted as Held. |
| `MULTICA_MVP_BLOCKED_STATUS` | `blocked` | Status key counted as Blocked. |
| `MULTICA_MVP_IDLE_HOURS` | `24` | Started card with no agent run for this long is idle. |
| `MULTICA_MVP_BURNDOWN_DAYS` | `30` | Burndown window (max 180). |

Names match case-insensitively. A workspace without the property or option gets `configured: false` and a
`problem` the page shows; the definition still renders.
