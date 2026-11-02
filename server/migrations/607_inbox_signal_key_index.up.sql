-- Smart inbox signals (contango, docs/contango/SMART-INBOX.md): one live
-- signal per (workspace, recipient, key). Resolving a signal stamps
-- details.resolved_at, which frees the key for a later raise.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_inbox_item_signal_key
    ON inbox_item (workspace_id, recipient_id, (details->>'key'))
    WHERE type = 'signal' AND (details->>'resolved_at') IS NULL;
