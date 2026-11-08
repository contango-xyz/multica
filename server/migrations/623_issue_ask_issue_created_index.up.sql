-- Single statement: the card's asks, oldest first (contango patch 30).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_ask_issue_created ON issue_ask (issue_id, created_at);
