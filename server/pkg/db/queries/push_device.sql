-- name: UpsertPushDevice :one
INSERT INTO push_device (user_id, platform, token, bundle_id, environment)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (token) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    platform = EXCLUDED.platform,
    bundle_id = EXCLUDED.bundle_id,
    environment = EXCLUDED.environment,
    last_seen_at = now(),
    disabled_at = NULL
RETURNING *;

-- name: ListEnabledPushDevicesByUser :many
-- The app re-registers on every launch, which bumps last_seen_at. A device
-- silent for 30 days (lost phone, revoked or expired session) gets nothing.
SELECT * FROM push_device
WHERE user_id = $1 AND disabled_at IS NULL
  AND last_seen_at > now() - interval '30 days'
ORDER BY created_at;

-- name: DeletePushDeviceForUser :exec
DELETE FROM push_device WHERE user_id = $1 AND token = $2;

-- name: DisablePushDeviceByToken :exec
UPDATE push_device SET disabled_at = now()
WHERE token = $1 AND disabled_at IS NULL;
