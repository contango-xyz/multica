-- Rules not yet dispatched lose their override and run with the agent's own settings.
ALTER TABLE issue_wakeup DROP COLUMN IF EXISTS run_override;
