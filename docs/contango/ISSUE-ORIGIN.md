# Where a card came from (contango, owner request 2026-11-03)

Upstream records a card's *source context* (the comment and thread it was created from, frozen as a
snapshot) only when a person turns a comment into a sub-issue in the UI. Agents file cards through
the CLI, which could not record it, so cards showed no origin. Two CLI options fill that gap.

## Flags

```sh
# File a card and record the comment it came from.
multica issue create --title "Fix the login" --from-comment <comment-uuid> [--parent CTG-12]

# Attach a source to a card that already exists (backfill). Refused when the card has one.
multica issue set-source CTG-123 --from-comment <comment-uuid> [--force]
```

- The comment may be on **any issue in the workspace**. It does **not** make the new card a sub-issue:
  `--parent` stays independent.
- The card shows **"Created from CTG-860 · <title>"** with a **Context snapshot** button (the frozen
  thread) and a link back to the live comment. When the source is the card's parent (the UI flow), the
  badge reads "Sub-issue of …" as upstream does; otherwise the ordinary parent line stays and the
  badge says "Created from".
- When an agent runs either command, the snapshot is stamped with its task (`origin_task_id`).
- Access: the caller must be able to read the comment's issue (as for commenting on it) and the target
  card (as for editing it). A comment from another workspace is "not found".
- `set-source` refuses a card that already has a source (`source_context_already_attached`, 409)
  unless `--force`, which replaces it (the old snapshot's copied attachments are deleted).

## API

- `POST /api/issues` accepts `"source_comment_id": "<uuid>"`. The 201 response includes
  `source_context`.
- `POST /api/issues/{id}/source-context` with `{"comment_id": "<uuid>", "force": false}` returns 200
  with the issue and its `source_context`, and publishes `issue:updated`.
- Errors reuse upstream's source-context codes (`anchor_comment_deleted`, `source_context_changed`,
  `source_context_too_large`, …); an unknown or foreign comment is 404.

No migration: it reuses upstream's `issue_source_context` table and attachment cloning.
