-- Smart inbox signals (contango, docs/contango/SMART-INBOX.md). A signal is an
-- inbox_item of type 'signal' whose details carry the feeder's key. At most
-- one unresolved signal exists per (workspace, recipient, key)
-- (idx_inbox_item_signal_key); resolving stamps details.resolved_at.

-- name: GetLiveInboxSignalForUpdate :one
SELECT * FROM inbox_item
WHERE workspace_id = $1
  AND recipient_type = 'member'
  AND recipient_id = $2
  AND type = 'signal'
  AND details->>'key' = sqlc.arg(signal_key)::text
  AND (details->>'resolved_at') IS NULL
FOR UPDATE;

-- name: InsertInboxSignal :one
-- A concurrent insert for the same key returns no row; the caller retries as
-- an update.
INSERT INTO inbox_item (
    id, workspace_id, recipient_type, recipient_id, type, severity, issue_id, title, body, details
) VALUES (
    $1, $2, 'member', $3, 'signal', $4, $5, $6, $7, $8
)
ON CONFLICT (workspace_id, recipient_id, (details->>'key'))
    WHERE type = 'signal' AND (details->>'resolved_at') IS NULL
DO NOTHING
RETURNING *;

-- name: UpdateInboxSignal :one
-- A re-raise brings the signal back to the top of the inbox: unread, not
-- archived, created_at now. A plain update leaves those as the user left them.
UPDATE inbox_item SET
    severity = $2,
    issue_id = $3,
    title = $4,
    body = $5,
    details = $6,
    read = CASE WHEN sqlc.arg(reraise)::bool THEN false ELSE read END,
    archived = CASE WHEN sqlc.arg(reraise)::bool THEN false ELSE archived END,
    created_at = CASE WHEN sqlc.arg(reraise)::bool THEN now() ELSE created_at END
WHERE id = $1
RETURNING *;

-- name: ResolveInboxSignal :one
UPDATE inbox_item SET
    archived = true,
    details = details || jsonb_build_object('resolved_at', now())
WHERE workspace_id = $1
  AND recipient_type = 'member'
  AND recipient_id = $2
  AND type = 'signal'
  AND details->>'key' = sqlc.arg(signal_key)::text
  AND (details->>'resolved_at') IS NULL
RETURNING *;
