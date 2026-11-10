-- contango patch 38: who is available when. Working hours stay the notification
-- preference `work_hours` (patch 24); this adds time off, a backup person and an
-- optional personal iCal feed. Workspace deletion cleans both tables in code.
CREATE TABLE IF NOT EXISTS member_availability (
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    backup_user_id UUID,
    personal_ical_url TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS member_time_off (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    half_day BOOLEAN NOT NULL DEFAULT false,
    label TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('manual', 'shared-ical', 'personal-ical')),
    external_uid TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_on >= starts_on)
);
