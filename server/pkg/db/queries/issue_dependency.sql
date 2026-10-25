-- Issue dependencies (contango). One edge type is written: 'blocked_by', where
-- issue_id cannot finish before depends_on_issue_id. "blocks" is the same edge
-- read from the other side, so it is never stored. The table's 'blocks' and
-- 'related' types (001_init) stay unused.

-- name: AddIssueBlockedBy :one
-- Workspace-guarded INSERT: both issues must belong to the workspace and differ.
-- Cycles are refused by the handler (IssueBlockedByWouldCycle) before this runs.
WITH inserted AS (
    INSERT INTO issue_dependency (issue_id, depends_on_issue_id, type)
    SELECT sqlc.arg('issue_id')::uuid, sqlc.arg('blocked_by_id')::uuid, 'blocked_by'
    WHERE sqlc.arg('issue_id')::uuid <> sqlc.arg('blocked_by_id')::uuid
      AND EXISTS (
        SELECT 1 FROM issue i
        WHERE i.id = sqlc.arg('issue_id')::uuid
          AND i.workspace_id = sqlc.arg('workspace_id')::uuid
    )
      AND EXISTS (
        SELECT 1 FROM issue b
        WHERE b.id = sqlc.arg('blocked_by_id')::uuid
          AND b.workspace_id = sqlc.arg('workspace_id')::uuid
    )
    ON CONFLICT DO NOTHING
    RETURNING issue_id
), bumped AS (
    UPDATE issue
    SET revision = revision + 1,
        last_activity_at = GREATEST(COALESCE(last_activity_at, updated_at), now())
    WHERE id IN (SELECT issue_id FROM inserted)
    RETURNING revision
)
SELECT EXISTS(SELECT 1 FROM inserted) AS changed,
       COALESCE((SELECT revision FROM bumped), 0)::bigint AS issue_revision;

-- name: RemoveIssueBlockedBy :one
WITH deleted AS (
    DELETE FROM issue_dependency d
    WHERE d.issue_id = sqlc.arg('issue_id')::uuid
      AND d.depends_on_issue_id = sqlc.arg('blocked_by_id')::uuid
      AND d.type = 'blocked_by'
      AND EXISTS (
        SELECT 1 FROM issue i
        WHERE i.id = d.issue_id
          AND i.workspace_id = sqlc.arg('workspace_id')::uuid
    )
    RETURNING d.issue_id
), bumped AS (
    UPDATE issue
    SET revision = revision + 1,
        last_activity_at = GREATEST(COALESCE(last_activity_at, updated_at), now())
    WHERE id IN (SELECT issue_id FROM deleted)
    RETURNING revision
)
SELECT EXISTS(SELECT 1 FROM deleted) AS changed,
       COALESCE((SELECT revision FROM bumped), 0)::bigint AS issue_revision;

-- name: IssueBlockedByWouldCycle :one
-- Adding "issue blocked by blocker" closes a cycle when the blocker is already
-- (transitively) blocked by the issue. UNION, not UNION ALL, so a cycle already
-- present in the data cannot loop the walk.
WITH RECURSIVE upstream(id) AS (
    SELECT d.depends_on_issue_id
    FROM issue_dependency d
    WHERE d.issue_id = sqlc.arg('blocked_by_id')::uuid AND d.type = 'blocked_by'
    UNION
    SELECT d.depends_on_issue_id
    FROM issue_dependency d
    JOIN upstream u ON d.issue_id = u.id
    WHERE d.type = 'blocked_by'
)
SELECT EXISTS(SELECT 1 FROM upstream WHERE id = sqlc.arg('issue_id')::uuid) AS cycles;

-- name: ListBlockedByForIssues :many
-- For each of the given issues, the issues it is blocked by.
SELECT d.issue_id, b.id, b.number, b.title, b.status
FROM issue_dependency d
JOIN issue b ON b.id = d.depends_on_issue_id
WHERE d.issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
  AND d.type = 'blocked_by'
  AND b.workspace_id = sqlc.arg('workspace_id')::uuid
ORDER BY d.issue_id, b.number;

-- name: ListBlocksForIssues :many
-- For each of the given issues, the issues it blocks.
SELECT d.depends_on_issue_id AS issue_id, i.id, i.number, i.title, i.status
FROM issue_dependency d
JOIN issue i ON i.id = d.issue_id
WHERE d.depends_on_issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
  AND d.type = 'blocked_by'
  AND i.workspace_id = sqlc.arg('workspace_id')::uuid
ORDER BY d.depends_on_issue_id, i.number;
