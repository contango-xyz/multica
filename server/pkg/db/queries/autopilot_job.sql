-- Contango patch 22: autopilot ops jobs (no agent). docs/contango/AUTOPILOT-JOBS.md.
-- A job run is pending -> running -> completed | failed, or skipped (overlap)
-- or expired (not claimed in time). Only job autopilots write 'pending', and
-- only a claimed run has started_at with no task_id.

-- name: LockAutopilotForJobFire :one
-- Serializes fires of one job autopilot so the overlap check and the insert
-- cannot interleave between two triggers or replicas.
SELECT * FROM autopilot
WHERE id = $1
FOR UPDATE;

-- name: HasActiveAutopilotJobRun :one
SELECT EXISTS (
    SELECT 1 FROM autopilot_run
    WHERE autopilot_id = $1 AND status IN ('pending', 'running')
) AS active;

-- name: InsertAutopilotJobRun :one
INSERT INTO autopilot_run (
    id, autopilot_id, trigger_id, source, status, planned_at,
    failure_reason, reason_code, completed_at
) VALUES (
    @id, @autopilot_id, sqlc.narg('trigger_id'), @source, @status, sqlc.narg('planned_at'),
    sqlc.narg('failure_reason'), sqlc.narg('reason_code'),
    CASE WHEN @status::text = 'skipped' THEN now() ELSE NULL END
) RETURNING *;

-- name: ExpireStaleAutopilotJobRuns :many
-- Pending runs nobody claimed before the cutoff become 'expired'. Optional
-- workspace / autopilot filters let claim, list and fire expire inline; the
-- periodic sweep passes neither.
UPDATE autopilot_run AS r
SET status = 'expired',
    completed_at = now(),
    failure_reason = 'not claimed by the ops runner in time'
FROM autopilot AS a
WHERE a.id = r.autopilot_id
  AND r.status = 'pending'
  AND r.triggered_at < @cutoff::timestamptz
  AND (sqlc.narg('workspace_id')::uuid IS NULL OR a.workspace_id = sqlc.narg('workspace_id')::uuid)
  AND (sqlc.narg('autopilot_id')::uuid IS NULL OR r.autopilot_id = sqlc.narg('autopilot_id')::uuid)
RETURNING r.id, r.autopilot_id, a.workspace_id;

-- name: ListAutopilotJobRuns :many
SELECT r.id, r.autopilot_id, a.title, a.job_name, r.status, r.source,
       r.triggered_at, r.started_at, r.completed_at, r.exit_code
FROM autopilot_run AS r
JOIN autopilot AS a ON a.id = r.autopilot_id
WHERE a.workspace_id = @workspace_id
  AND a.execution_mode = 'job'
  AND r.status = @status::text
ORDER BY r.triggered_at ASC, r.id ASC
LIMIT @row_limit;

-- name: GetAutopilotJobRunInWorkspace :one
SELECT r.id, r.autopilot_id, a.title, a.job_name, a.execution_mode, r.status, r.source,
       r.triggered_at, r.started_at, r.completed_at, r.exit_code, r.task_id
FROM autopilot_run AS r
JOIN autopilot AS a ON a.id = r.autopilot_id
WHERE r.id = @id AND a.workspace_id = @workspace_id;

-- name: ClaimAutopilotJobRun :one
-- Atomic pending -> running. A second claim, or a claim after the run went
-- stale, matches no row.
UPDATE autopilot_run AS r
SET status = 'running', started_at = now()
FROM autopilot AS a
WHERE r.id = @id
  AND a.id = r.autopilot_id
  AND a.workspace_id = @workspace_id
  AND a.execution_mode = 'job'
  AND r.status = 'pending'
  AND r.triggered_at >= @cutoff::timestamptz
RETURNING r.id, r.autopilot_id, a.title, a.job_name, r.status, r.source,
          r.triggered_at, r.started_at, r.completed_at, r.exit_code;

-- name: FinishAutopilotJobRun :one
-- running -> completed | failed, only for a claimed job run (started_at set,
-- no agent task), so the runner can never settle an agent run.
UPDATE autopilot_run AS r
SET status = @status::text,
    completed_at = now(),
    exit_code = sqlc.narg('exit_code'),
    output_tail = sqlc.narg('output_tail'),
    failure_reason = CASE WHEN @status::text = 'failed' THEN sqlc.narg('failure_reason')::text ELSE NULL END
FROM autopilot AS a
WHERE r.id = @id
  AND a.id = r.autopilot_id
  AND a.workspace_id = @workspace_id
  AND r.status = 'running'
  AND r.started_at IS NOT NULL
  AND r.task_id IS NULL
RETURNING r.id, r.autopilot_id, a.title, a.job_name, r.status, r.source,
          r.triggered_at, r.started_at, r.completed_at, r.exit_code;
