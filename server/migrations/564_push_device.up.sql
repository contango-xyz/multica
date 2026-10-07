-- Device tokens for native push (APNs). No foreign keys by repo rule; rows
-- are owned by user_id and cleaned up in application code.
CREATE TABLE IF NOT EXISTS push_device (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios')),
    token TEXT NOT NULL,
    bundle_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at TIMESTAMPTZ
);
