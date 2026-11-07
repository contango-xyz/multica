-- Reverses 617_autopilot_job. Job autopilots cannot exist under the old
-- schema (no assignee, unknown mode), so they are deleted with their runs and
-- triggers (FK cascade); subscribers and collaborators carry no FK and are
-- deleted explicitly.
DELETE FROM autopilot_subscriber
WHERE autopilot_id IN (SELECT id FROM autopilot WHERE execution_mode = 'job');
DELETE FROM autopilot_collaborator
WHERE autopilot_id IN (SELECT id FROM autopilot WHERE execution_mode = 'job');
DELETE FROM autopilot_rule_version
WHERE autopilot_id IN (SELECT id FROM autopilot WHERE execution_mode = 'job');
DELETE FROM autopilot WHERE execution_mode = 'job';

-- Defensive: no other mode writes these statuses.
UPDATE autopilot_run
SET status = 'failed',
    completed_at = COALESCE(completed_at, now()),
    failure_reason = COALESCE(failure_reason, 'migrated from job run status')
WHERE status IN ('pending', 'expired');

ALTER TABLE autopilot_run DROP CONSTRAINT IF EXISTS autopilot_run_status_check;
ALTER TABLE autopilot_run ADD CONSTRAINT autopilot_run_status_check
    CHECK (status IN ('issue_created', 'running', 'completed', 'failed', 'skipped'));

ALTER TABLE autopilot_run
    DROP COLUMN IF EXISTS started_at,
    DROP COLUMN IF EXISTS exit_code,
    DROP COLUMN IF EXISTS output_tail;

ALTER TABLE autopilot DROP CONSTRAINT IF EXISTS autopilot_job_shape_check;
ALTER TABLE autopilot ALTER COLUMN assignee_id SET NOT NULL;

ALTER TABLE autopilot DROP CONSTRAINT IF EXISTS autopilot_execution_mode_check;
ALTER TABLE autopilot ADD CONSTRAINT autopilot_execution_mode_check
    CHECK (execution_mode IN ('create_issue', 'run_only'));

ALTER TABLE autopilot DROP COLUMN IF EXISTS job_name;
