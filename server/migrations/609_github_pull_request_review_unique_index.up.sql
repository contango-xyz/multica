-- Single statement: the upsert key of github_pull_request_review, and the
-- index behind its per-PR lookups and the workspace cleanup deletes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS github_pull_request_review_pr_review_idx
    ON github_pull_request_review (pull_request_id, github_review_id);
