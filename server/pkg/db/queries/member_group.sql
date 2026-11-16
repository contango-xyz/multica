-- Role mention groups (contango patch 48).

-- name: ListMemberGroups :many
SELECT * FROM member_group
WHERE workspace_id = $1 AND archived_at IS NULL
ORDER BY handle;

-- name: GetMemberGroup :one
SELECT * FROM member_group
WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL;

-- name: GetMemberGroupByHandle :one
SELECT * FROM member_group
WHERE workspace_id = $1 AND handle = lower(sqlc.arg('handle')::text) AND archived_at IS NULL;

-- name: CreateMemberGroup :one
INSERT INTO member_group (workspace_id, handle, name, description, fallback_user_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: UpdateMemberGroup :one
UPDATE member_group
SET handle = $3, name = $4, description = $5, fallback_user_id = $6, updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
RETURNING *;

-- name: ArchiveMemberGroup :execrows
UPDATE member_group SET archived_at = now(), updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL;

-- name: ListMemberGroupMembers :many
-- Every member row of the workspace's live groups, in each group's order.
SELECT gm.* FROM member_group_member gm
JOIN member_group g ON g.id = gm.group_id
WHERE gm.workspace_id = $1 AND g.archived_at IS NULL
ORDER BY gm.group_id, gm.position, gm.created_at;

-- name: DeleteMemberGroupMembers :exec
DELETE FROM member_group_member WHERE group_id = $1 AND workspace_id = $2;

-- name: AddMemberGroupMember :exec
INSERT INTO member_group_member (group_id, workspace_id, user_id, position)
VALUES ($1, $2, $3, $4)
ON CONFLICT (group_id, user_id) DO UPDATE SET position = EXCLUDED.position;
