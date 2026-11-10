CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_member_time_off_range ON member_time_off (workspace_id, ends_on, starts_on);
