-- Contango patch 30: asks as real objects (docs/contango/PATCHES.md).

-- name: CreateIssueAsk :one
INSERT INTO issue_ask (
    id, workspace_id, issue_id, comment_id, task_id, pr_id,
    author_type, author_id, addressee_type, addressee_id, addressee_role,
    kind, topic, options, recommended, default_option, reversible, expires_at, source
) VALUES (
    @id, @workspace_id, @issue_id, @comment_id, @task_id, @pr_id,
    @author_type, @author_id, @addressee_type, @addressee_id, @addressee_role,
    @kind, @topic, @options, @recommended, @default_option, @reversible, @expires_at, @source
)
RETURNING *;

-- name: GetIssueAsk :one
SELECT * FROM issue_ask WHERE id = @id AND workspace_id = @workspace_id;

-- name: ListIssueAsks :many
SELECT * FROM issue_ask
WHERE issue_id = @issue_id AND workspace_id = @workspace_id
  AND (sqlc.narg(state)::text IS NULL OR state = sqlc.narg(state))
ORDER BY created_at, id
LIMIT @row_limit;

-- name: GetOldestOpenIssueAsk :one
SELECT * FROM issue_ask
WHERE issue_id = @issue_id AND workspace_id = @workspace_id AND state = 'open'
ORDER BY created_at, id
LIMIT 1;

-- name: AnswerIssueAsk :one
-- Compare-and-set on state: of two racing answers the first wins and the other
-- gets no row.
UPDATE issue_ask
SET state = 'answered', answer_text = @answer_text, answer_comment_id = @answer_comment_id,
    answered_by_type = @answered_by_type, answered_by = @answered_by, answered_via = @answered_via,
    closed_at = now(), updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id AND state = 'open'
RETURNING *;

-- name: WithdrawIssueAsk :one
UPDATE issue_ask
SET state = 'withdrawn', answer_text = @answer_text,
    answered_by_type = @answered_by_type, answered_by = @answered_by,
    closed_at = now(), updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id AND state = 'open'
RETURNING *;

-- name: WithdrawOpenIssueAsksByIssue :execrows
UPDATE issue_ask
SET state = 'withdrawn', answer_text = @answer_text, closed_at = now(), updated_at = now()
WHERE issue_id = @issue_id AND workspace_id = @workspace_id AND state = 'open';

-- name: WithdrawOpenIssueAskByComment :execrows
UPDATE issue_ask
SET state = 'withdrawn', answer_text = @answer_text, closed_at = now(), updated_at = now()
WHERE comment_id = @comment_id AND workspace_id = @workspace_id AND state = 'open';

-- name: ListCommentAncestorIDs :many
-- The comment and its parents, nearest first; the last row is the thread root.
WITH RECURSIVE chain AS (
    SELECT c.id, c.parent_id, 0 AS depth
    FROM comment c
    WHERE c.id = @comment_id AND c.workspace_id = @workspace_id
    UNION ALL
    SELECT p.id, p.parent_id, chain.depth + 1
    FROM comment p
    JOIN chain ON p.id = chain.parent_id
)
SELECT chain.id FROM chain ORDER BY chain.depth;
