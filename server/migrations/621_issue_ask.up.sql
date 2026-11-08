-- Contango patch 30: asks as real objects (docs/contango/PATCHES.md).
--
-- One row per [NEEDS HUMAN] / [NEEDS OPERATOR] ask. The ask's comment is
-- written in the same transaction and keeps today's format, so the comment
-- stays the record readers see and this row carries what used to be inferred
-- from it. No foreign keys, per the repo's migration rules; rows go with the
-- issue and the workspace in application code. The indexes are built
-- concurrently in 622 and 623.
CREATE TABLE IF NOT EXISTS issue_ask (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID        NOT NULL,
    issue_id          UUID        NOT NULL,
    comment_id        UUID        NOT NULL,
    task_id           UUID,
    pr_id             UUID,
    author_type       TEXT        NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id         UUID        NOT NULL,
    addressee_type    TEXT        NOT NULL CHECK (addressee_type IN ('member', 'agent', 'role')),
    addressee_id      UUID,
    addressee_role    TEXT        CHECK (addressee_role IN ('operator')),
    kind              TEXT        NOT NULL
        CHECK (kind IN ('merge', 'decision', 'access', 'admission', 'tech_owner', 'operator')),
    topic             TEXT        NOT NULL,
    options           JSONB       NOT NULL DEFAULT '[]'::jsonb,
    recommended       TEXT,
    default_option    TEXT,
    reversible        BOOLEAN     NOT NULL DEFAULT false,
    state             TEXT        NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'answered', 'withdrawn', 'expired')),
    answer_text       TEXT,
    answer_comment_id UUID,
    answered_by_type  TEXT        CHECK (answered_by_type IN ('member', 'agent')),
    answered_by       UUID,
    answered_via      TEXT
        CHECK (answered_via IN ('one_tap', 'comment', 'status_move', 'pr_approved', 'default_applied', 'ops')),
    expires_at        TIMESTAMPTZ,
    source            TEXT        NOT NULL DEFAULT 'cli' CHECK (source IN ('cli', 'marker')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at         TIMESTAMPTZ,
    CONSTRAINT issue_ask_addressee_shape CHECK (
        (addressee_type IN ('member', 'agent') AND addressee_id IS NOT NULL AND addressee_role IS NULL)
        OR (addressee_type = 'role' AND addressee_id IS NULL AND addressee_role IS NOT NULL)
    )
);
