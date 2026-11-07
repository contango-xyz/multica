-- Contango patch 22: backs the ops-job queries (docs/contango/AUTOPILOT-JOBS.md):
-- the per-autopilot overlap check (a pending or running run blocks a new fire),
-- the runner's pending list and the 10-minute expiry sweep. Only in-flight rows
-- are indexed, so it stays tiny. CONCURRENTLY because autopilot_run is written
-- on every autopilot fire; single statement because the runner cannot mix
-- CONCURRENTLY with other statements in one file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_autopilot_run_job_active
    ON autopilot_run (autopilot_id, triggered_at)
    WHERE status IN ('pending', 'running');
