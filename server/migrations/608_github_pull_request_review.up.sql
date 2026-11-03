-- GitHub pull request reviews (contango, docs/contango/PATCHES.md): who approved,
-- requested changes or commented, on which commit. Written from the
-- pull_request_review webhook and backfilled by the PR snapshot refresh.
--
-- One row per (mirrored PR row, GitHub review). The same installation can be
-- bound to several workspaces, each mirroring its own github_pull_request row,
-- so the GitHub review id is unique per PR row, not globally. Like
-- github_pull_request_check_run, the table has no foreign key and no primary
-- key: rows are removed with their workspace in application code, and the
-- unique index is built CONCURRENTLY in its own migration (609).
CREATE TABLE IF NOT EXISTS github_pull_request_review (
    pull_request_id  UUID        NOT NULL,
    github_review_id BIGINT      NOT NULL,
    reviewer_login   TEXT        NOT NULL,
    -- GitHub account type: 'User' or 'Bot' (kept as sent).
    reviewer_type    TEXT        NOT NULL,
    state            TEXT        NOT NULL
        CHECK (state IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED')),
    commit_id        TEXT,
    submitted_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
