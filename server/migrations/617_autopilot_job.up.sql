-- Contango patch 22: autopilot ops jobs (no agent). docs/contango/AUTOPILOT-JOBS.md.
--
-- A third execution mode, 'job': firing records a pending autopilot_run that an
-- external ops runner claims and finishes over the API. No issue, task or
-- wakeup is created and no agent runs, so a job autopilot has no assignee.
--
-- autopilot.job_name is the key the runner maps to its own fixed command list
-- (the server never runs commands). It is set exactly when execution_mode is
-- 'job', and a job row carries no assignee; every other mode keeps the old
-- NOT NULL assignee rule through the shape check instead of the column.

ALTER TABLE autopilot ADD COLUMN IF NOT EXISTS job_name TEXT;

ALTER TABLE autopilot DROP CONSTRAINT IF EXISTS autopilot_execution_mode_check;
ALTER TABLE autopilot ADD CONSTRAINT autopilot_execution_mode_check
    CHECK (execution_mode IN ('create_issue', 'run_only', 'job'));

ALTER TABLE autopilot ALTER COLUMN assignee_id DROP NOT NULL;

ALTER TABLE autopilot ADD CONSTRAINT autopilot_job_shape_check CHECK (
    (
        execution_mode = 'job'
        AND assignee_id IS NULL
        AND job_name IS NOT NULL
        AND job_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'
    )
    OR (
        execution_mode <> 'job'
        AND assignee_id IS NOT NULL
        AND job_name IS NULL
    )
);

-- Run statuses for jobs: 'pending' (fired, waiting for the runner) and
-- 'expired' (nobody claimed it within 10 minutes). A job run then goes
-- running -> completed | failed like the other modes, and an overlapping fire
-- is recorded as 'skipped'. Migration 043 removed an older, unused 'pending'.
ALTER TABLE autopilot_run DROP CONSTRAINT IF EXISTS autopilot_run_status_check;
ALTER TABLE autopilot_run ADD CONSTRAINT autopilot_run_status_check
    CHECK (status IN ('issue_created', 'running', 'completed', 'failed', 'skipped', 'pending', 'expired'));

-- What the runner reports. started_at is the claim time; completed_at (the
-- existing column) is the finish time. output_tail holds at most 8 KiB.
ALTER TABLE autopilot_run
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS exit_code INTEGER,
    ADD COLUMN IF NOT EXISTS output_tail TEXT;
