-- contango patch 48: role mention groups (docs/contango/PATCHES.md). A named group
-- of people (@devops, @be, ...) that a comment can @mention; the server expands it
-- to the members on duty (time off skipped, then backups, then the fallback).
-- No foreign keys, per the repo's migration rules: workspace deletion cleans both
-- tables in code, and a removed person is ignored because duty is computed from
-- current workspace members. The handle index is built concurrently in 629.
CREATE TABLE IF NOT EXISTS member_group (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID        NOT NULL,
    handle           TEXT        NOT NULL CHECK (handle ~ '^[a-z][a-z0-9-]{1,23}$'),
    name             TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    fallback_user_id UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS member_group_member (
    group_id     UUID        NOT NULL,
    workspace_id UUID        NOT NULL,
    user_id      UUID        NOT NULL,
    position     INT         NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
