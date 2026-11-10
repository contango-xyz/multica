CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_member_time_off_external ON member_time_off (workspace_id, source, user_id, external_uid) WHERE external_uid IS NOT NULL;
