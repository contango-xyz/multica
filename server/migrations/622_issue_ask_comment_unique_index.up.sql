-- Single statement: one ask per comment (contango patch 30).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_ask_comment ON issue_ask (comment_id);
