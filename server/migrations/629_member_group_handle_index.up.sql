CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_member_group_handle ON member_group (workspace_id, handle) WHERE archived_at IS NULL;
