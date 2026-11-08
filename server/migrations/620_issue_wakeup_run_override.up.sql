-- Contango patch 29: per-run seat and effort overrides. A one-shot rule from
-- `wakeup now --runtime-id/--model/--thinking-level` keeps its override here
-- until it dispatches, because a dispatch can be deferred to the scheduler.
-- Nullable with no default, so no table rewrite and no row backfill.
ALTER TABLE issue_wakeup ADD COLUMN IF NOT EXISTS run_override jsonb;
