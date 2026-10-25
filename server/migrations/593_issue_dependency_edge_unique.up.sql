CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_dependency_edge
    ON issue_dependency(issue_id, depends_on_issue_id, type);
