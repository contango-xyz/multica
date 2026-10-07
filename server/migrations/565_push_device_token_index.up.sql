-- One row per APNs token; re-registration upserts on it.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_push_device_token
    ON push_device (token);
