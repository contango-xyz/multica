package service

// Contango patch 22: autopilot ops jobs (no agent). docs/contango/AUTOPILOT-JOBS.md.
//
// A job autopilot (execution_mode "job") fires like any other autopilot, but
// the fire only records a pending autopilot_run. It never creates an issue, a
// task or a wakeup and never runs an agent: an external ops runner lists the
// pending runs, claims one, runs the command it maps to the autopilot's
// job_name, and reports the result.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/dispatch"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	// ExecutionModeJob is the ops-job execution mode.
	ExecutionModeJob = "job"

	// AutopilotJobClaimWindow is how long a pending job run waits for the
	// runner before it becomes "expired".
	AutopilotJobClaimWindow = 10 * time.Minute

	// AutopilotJobOutputTailMax is the most output_tail bytes kept per run.
	AutopilotJobOutputTailMax = 8 * 1024

	autopilotJobOverlapReason = "previous run of this job is still pending or running"
)

var jobNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// ValidJobName reports whether name is a valid ops job key.
func ValidJobName(name string) bool {
	return jobNamePattern.MatchString(name)
}

// autopilotJobCutoff is the oldest triggered_at a pending run may have and
// still be claimable.
func autopilotJobCutoff(now time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: now.Add(-AutopilotJobClaimWindow), Valid: true}
}

// AutopilotJobCutoff is autopilotJobCutoff for the handler.
func AutopilotJobCutoff(now time.Time) pgtype.Timestamptz { return autopilotJobCutoff(now) }

// TruncateJobOutputTail keeps the last AutopilotJobOutputTailMax bytes of s,
// cutting from the start and never inside a UTF-8 sequence. Invalid UTF-8 and
// NUL bytes (which Postgres text rejects) are replaced first.
func TruncateJobOutputTail(s string) string {
	s = strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "\uFFFD")
	if len(s) <= AutopilotJobOutputTailMax {
		return s
	}
	start := len(s) - AutopilotJobOutputTailMax
	// Skip UTF-8 continuation bytes (10xxxxxx) so the tail starts on a rune.
	for start < len(s) && s[start]&0xC0 == 0x80 {
		start++
	}
	return s[start:]
}

// dispatchJob records one fire of a job autopilot: a pending run, or a skipped
// one when a previous run is still pending or running. The overlap check and
// the insert run under a row lock on the autopilot so two triggers (or two
// replicas) cannot both see "no active run".
func (s *AutopilotService) dispatchJob(
	ctx context.Context,
	autopilot db.Autopilot,
	triggerID pgtype.UUID,
	source string,
	plannedAt pgtype.Timestamptz,
) (*db.AutopilotRun, dispatch.ReasonCode, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: begin: %w", err)
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)

	locked, err := qtx.LockAutopilotForJobFire(ctx, autopilot.ID)
	if err != nil {
		return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: lock autopilot: %w", err)
	}
	if locked.ExecutionMode != ExecutionModeJob {
		return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: autopilot %s is no longer a job", util.UUIDToString(autopilot.ID))
	}

	params := db.InsertAutopilotJobRunParams{
		ID:          dbid.NewV7(),
		AutopilotID: autopilot.ID,
		TriggerID:   triggerID,
		Source:      source,
		Status:      "pending",
		PlannedAt:   plannedAt,
	}
	var code dispatch.ReasonCode
	var expired []db.ExpireStaleAutopilotJobRunsRow
	if locked.Status != "active" {
		// Callers check status before dispatching; this closes the race with a
		// pause that landed in between.
		params.Status = "skipped"
		params.FailureReason = pgtype.Text{String: "autopilot is not active", Valid: true}
		code = dispatch.ReasonTargetUnavailable
	} else {
		expired, err = qtx.ExpireStaleAutopilotJobRuns(ctx, db.ExpireStaleAutopilotJobRunsParams{
			Cutoff:      autopilotJobCutoff(time.Now()),
			AutopilotID: autopilot.ID,
		})
		if err != nil {
			return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: expire stale runs: %w", err)
		}
		active, err := qtx.HasActiveAutopilotJobRun(ctx, autopilot.ID)
		if err != nil {
			return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: overlap check: %w", err)
		}
		if active {
			params.Status = "skipped"
			params.FailureReason = pgtype.Text{String: autopilotJobOverlapReason, Valid: true}
			code = dispatch.ReasonAlreadyActive
		}
	}
	if code != "" {
		params.ReasonCode = pgtype.Text{String: string(code), Valid: true}
	}

	run, err := qtx.InsertAutopilotJobRun(ctx, params)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && triggerID.Valid && plannedAt.Valid {
			// A retry of the same scheduled occurrence: hand back the first run.
			tx.Rollback(ctx)
			existing, lookupErr := s.Queries.GetAutopilotRunByTriggerAndPlanned(ctx, db.GetAutopilotRunByTriggerAndPlannedParams{
				TriggerID: triggerID,
				PlannedAt: plannedAt,
			})
			if lookupErr != nil {
				return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: lookup existing run: %w", lookupErr)
			}
			return &existing, dispatch.ReasonCode(existing.ReasonCode.String), nil
		}
		return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: insert run: %w", err)
	}
	if err := qtx.UpdateAutopilotLastRunAt(ctx, autopilot.ID); err != nil {
		return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: touch last_run_at: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, dispatch.ReasonInternalError, fmt.Errorf("dispatch job: commit: %w", err)
	}
	s.publishExpiredJobRuns(expired)

	workspaceID := util.UUIDToString(autopilot.WorkspaceID)
	if run.Status == "skipped" {
		slog.Info("autopilot job skipped",
			"autopilot_id", util.UUIDToString(autopilot.ID),
			"run_id", util.UUIDToString(run.ID),
			"reason", run.FailureReason.String,
		)
		s.publishRunDone(workspaceID, run, run.Status)
		return &run, code, nil
	}
	slog.Info("autopilot job fired",
		"autopilot_id", util.UUIDToString(autopilot.ID),
		"run_id", util.UUIDToString(run.ID),
		"job_name", locked.JobName.String,
		"source", source,
	)
	s.Bus.Publish(events.Event{
		Type:        protocol.EventAutopilotRunStart,
		WorkspaceID: workspaceID,
		ActorType:   "system",
		Payload: map[string]any{
			"run_id":       util.UUIDToString(run.ID),
			"autopilot_id": util.UUIDToString(autopilot.ID),
			"source":       source,
			"status":       run.Status,
		},
	})
	return &run, "", nil
}

// dispatchJobForPlan is DispatchAutopilotForPlan for a job autopilot: a run
// already recorded for this (trigger, planned_at) is returned as-is, whatever
// its status, so a scheduler retry never fires the job twice.
func (s *AutopilotService) dispatchJobForPlan(
	ctx context.Context,
	autopilot db.Autopilot,
	triggerID pgtype.UUID,
	source string,
	plannedAt pgtype.Timestamptz,
) (*db.AutopilotRun, error) {
	existing, err := s.Queries.GetAutopilotRunByTriggerAndPlanned(ctx, db.GetAutopilotRunByTriggerAndPlannedParams{
		TriggerID: triggerID,
		PlannedAt: plannedAt,
	})
	switch {
	case err == nil:
		return &existing, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return nil, fmt.Errorf("dispatch job for plan: lookup existing run: %w", err)
	}
	run, _, err := s.dispatchJob(ctx, autopilot, triggerID, source, plannedAt)
	return run, err
}

// ExpireStaleAutopilotJobRuns marks pending job runs older than the claim
// window as expired. workspaceID / autopilotID narrow it when valid. Returns
// how many runs expired.
func (s *AutopilotService) ExpireStaleAutopilotJobRuns(ctx context.Context, workspaceID, autopilotID pgtype.UUID) (int, error) {
	expired, err := s.Queries.ExpireStaleAutopilotJobRuns(ctx, db.ExpireStaleAutopilotJobRunsParams{
		Cutoff:      autopilotJobCutoff(time.Now()),
		WorkspaceID: workspaceID,
		AutopilotID: autopilotID,
	})
	if err != nil {
		return 0, err
	}
	s.publishExpiredJobRuns(expired)
	return len(expired), nil
}

func (s *AutopilotService) publishExpiredJobRuns(expired []db.ExpireStaleAutopilotJobRunsRow) {
	for _, row := range expired {
		slog.Info("autopilot job run expired",
			"autopilot_id", util.UUIDToString(row.AutopilotID),
			"run_id", util.UUIDToString(row.ID),
		)
		s.publishRunDone(util.UUIDToString(row.WorkspaceID), db.AutopilotRun{ID: row.ID, AutopilotID: row.AutopilotID}, "expired")
	}
}

// PublishAutopilotJobRunDone tells clients a job run finished.
func (s *AutopilotService) PublishAutopilotJobRunDone(workspaceID string, runID, autopilotID pgtype.UUID, status string) {
	s.publishRunDone(workspaceID, db.AutopilotRun{ID: runID, AutopilotID: autopilotID}, status)
}
