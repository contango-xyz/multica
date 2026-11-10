-- name: ListMemberAvailability :many
SELECT * FROM member_availability WHERE workspace_id = $1;

-- name: UpsertMemberAvailability :one
INSERT INTO member_availability (workspace_id, user_id, backup_user_id, personal_ical_url)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workspace_id, user_id)
DO UPDATE SET backup_user_id = EXCLUDED.backup_user_id, personal_ical_url = EXCLUDED.personal_ical_url, updated_at = now()
RETURNING *;

-- name: GetMemberAvailability :one
SELECT * FROM member_availability WHERE workspace_id = $1 AND user_id = $2;

-- name: ListMemberTimeOff :many
SELECT * FROM member_time_off
WHERE workspace_id = $1 AND ends_on >= sqlc.arg('from_day')::date AND starts_on <= sqlc.arg('to_day')::date
ORDER BY starts_on, user_id;

-- name: CreateMemberTimeOff :one
INSERT INTO member_time_off (workspace_id, user_id, starts_on, ends_on, half_day, label, source)
VALUES ($1, $2, $3, $4, $5, $6, 'manual')
RETURNING *;

-- name: DeleteManualMemberTimeOff :execrows
DELETE FROM member_time_off
WHERE id = $1 AND workspace_id = $2 AND user_id = $3 AND source = 'manual';

-- name: UpsertImportedMemberTimeOff :one
INSERT INTO member_time_off (workspace_id, user_id, starts_on, ends_on, half_day, label, source, external_uid)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (workspace_id, source, user_id, external_uid) WHERE external_uid IS NOT NULL
DO UPDATE SET starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on, half_day = EXCLUDED.half_day,
              label = EXCLUDED.label, updated_at = now()
RETURNING *;

-- name: DeleteStaleImportedMemberTimeOff :execrows
-- An import replaces its source for the users it covers: entries it no longer sends are gone.
DELETE FROM member_time_off
WHERE workspace_id = $1 AND source = $2 AND user_id = ANY(sqlc.arg('user_ids')::uuid[])
  AND NOT (external_uid = ANY(sqlc.arg('keep_uids')::text[]));
