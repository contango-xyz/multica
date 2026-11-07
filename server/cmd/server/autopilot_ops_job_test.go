package main

// Contango patch 22: a scheduled ops job records a pending run and never
// creates an issue or task; overlap is skipped; pause stops firing.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/scheduler"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestAutopilotOpsJobScheduleFiresWithoutAgent(t *testing.T) {
	ctx := context.Background()
	queries := db.New(testPool)
	bus := events.New()
	taskSvc := service.NewTaskService(queries, testPool, nil, bus)
	autopilotSvc := service.NewAutopilotService(queries, testPool, bus, taskSvc)

	ap, err := queries.CreateAutopilot(ctx, db.CreateAutopilotParams{
		WorkspaceID:   parseUUID(testWorkspaceID),
		Title:         "Ops job fixture",
		AssigneeType:  "agent",
		Status:        "active",
		ExecutionMode: service.ExecutionModeJob,
		JobName:       pgtype.Text{String: "pr-watch", Valid: true},
		CreatedByType: "member",
		CreatedByID:   parseUUID(testUserID),
	})
	if err != nil {
		t.Fatalf("CreateAutopilot(job): %v", err)
	}
	if ap.AssigneeID.Valid {
		t.Fatalf("job autopilot must have no assignee")
	}
	trigger, err := queries.CreateAutopilotTrigger(ctx, db.CreateAutopilotTriggerParams{
		AutopilotID:    ap.ID,
		Kind:           "schedule",
		Enabled:        true,
		CronExpression: pgtype.Text{String: "*/1 * * * *", Valid: true},
		Timezone:       pgtype.Text{String: "UTC", Valid: true},
		CreatedByType:  pgtype.Text{String: "member", Valid: true},
		CreatedByID:    ap.CreatedByID,
	})
	if err != nil {
		t.Fatalf("CreateAutopilotTrigger: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = testPool.Exec(bg, `DELETE FROM sys_cron_executions WHERE scope_kind = $1 AND scope_id = $2`,
			scheduler.ScopeKindAutopilotTrigger, util.UUIDToString(trigger.ID))
		_, _ = testPool.Exec(bg, `DELETE FROM autopilot WHERE id = $1`, ap.ID)
	})

	job := scheduler.AutopilotScheduleDispatchJob(testPool, queries, autopilotSvc)
	fire := func(plan time.Time) scheduler.HandlerResult {
		t.Helper()
		res, err := job.Handler(ctx, scheduler.HandlerInput{
			Job:       &job,
			Scope:     scheduler.Scope{Kind: scheduler.ScopeKindAutopilotTrigger, ID: util.UUIDToString(trigger.ID)},
			PlanTime:  plan,
			Attempt:   1,
			RunnerID:  "ops-job-test",
			Heartbeat: func(context.Context) error { return nil },
		})
		if err != nil {
			t.Fatalf("handler: %v", err)
		}
		return res
	}
	countRuns := func(status string) int {
		t.Helper()
		var n int
		if err := testPool.QueryRow(ctx, `SELECT count(*) FROM autopilot_run WHERE autopilot_id = $1 AND status = $2`, ap.ID, status).Scan(&n); err != nil {
			t.Fatalf("count runs: %v", err)
		}
		return n
	}

	plan := time.Now().UTC().Truncate(time.Minute)
	fire(plan)
	if got := countRuns("pending"); got != 1 {
		t.Fatalf("first fire: want 1 pending run, got %d", got)
	}
	var issues, tasks int
	testPool.QueryRow(ctx, `SELECT count(*) FROM issue WHERE origin_type = 'autopilot' AND origin_id = $1`, ap.ID).Scan(&issues)
	testPool.QueryRow(ctx, `SELECT count(*) FROM agent_task_queue t JOIN autopilot_run r ON r.id = t.autopilot_run_id WHERE r.autopilot_id = $1`, ap.ID).Scan(&tasks)
	if issues != 0 || tasks != 0 {
		t.Fatalf("job fire must create no issue or task, got issues=%d tasks=%d", issues, tasks)
	}

	// A scheduler retry of the same occurrence reuses the run.
	fire(plan)
	if got := countRuns("pending"); got != 1 {
		t.Fatalf("retry of the same plan: want still 1 pending run, got %d", got)
	}

	// The next occurrence while the first is still pending is an overlap.
	fire(plan.Add(time.Minute))
	if got := countRuns("skipped"); got != 1 {
		t.Fatalf("overlap: want 1 skipped run, got %d", got)
	}
	var reason string
	testPool.QueryRow(ctx, `SELECT reason_code FROM autopilot_run WHERE autopilot_id = $1 AND status = 'skipped'`, ap.ID).Scan(&reason)
	if reason != "already_active" {
		t.Fatalf("overlap reason_code: want already_active, got %q", reason)
	}

	// Pause stops firing.
	if _, err := testPool.Exec(ctx, `UPDATE autopilot SET status = 'paused' WHERE id = $1`, ap.ID); err != nil {
		t.Fatalf("pause: %v", err)
	}
	res := fire(plan.Add(2 * time.Minute))
	if got, _ := res.Result["skipped_reason"].(string); got != "autopilot_inactive" {
		t.Fatalf("paused job: want skipped_reason=autopilot_inactive, got %q", got)
	}
	var total int
	testPool.QueryRow(ctx, `SELECT count(*) FROM autopilot_run WHERE autopilot_id = $1`, ap.ID).Scan(&total)
	if total != 2 {
		t.Fatalf("paused job must not fire: want 2 runs total, got %d", total)
	}
}
