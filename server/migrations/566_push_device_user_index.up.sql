-- Serves the per-recipient device lookup on every push.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_push_device_user
    ON push_device (user_id);
