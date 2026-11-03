-- GitHub pull request reviews (contango). See migration 608.

-- name: UpsertGitHubPRReview :exec
-- Idempotent per (PR row, GitHub review). A dismissal is final on GitHub, so a
-- late "submitted"/"edited" delivery or an older backfill never revives a
-- dismissed review.
INSERT INTO github_pull_request_review (
    pull_request_id, github_review_id, reviewer_login, reviewer_type, state, commit_id, submitted_at
) VALUES (
    sqlc.arg(pull_request_id), sqlc.arg(github_review_id), sqlc.arg(reviewer_login),
    sqlc.arg(reviewer_type), sqlc.arg(state), sqlc.narg(commit_id), sqlc.narg(submitted_at)
)
ON CONFLICT (pull_request_id, github_review_id) DO UPDATE SET
    reviewer_login = EXCLUDED.reviewer_login,
    reviewer_type  = EXCLUDED.reviewer_type,
    state = CASE WHEN github_pull_request_review.state = 'DISMISSED' THEN 'DISMISSED' ELSE EXCLUDED.state END,
    commit_id      = COALESCE(EXCLUDED.commit_id, github_pull_request_review.commit_id),
    submitted_at   = COALESCE(EXCLUDED.submitted_at, github_pull_request_review.submitted_at),
    updated_at     = now();

-- name: ListGitHubPRReviews :many
SELECT * FROM github_pull_request_review
WHERE pull_request_id = $1
ORDER BY submitted_at NULLS LAST, github_review_id;
