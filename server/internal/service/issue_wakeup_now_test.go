package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func wakeNow(t *testing.T, f principalFixture, s *IssueWakeupService, issue pgtype.UUID, in WakeupNowInput) WakeupNowResult {
	t.Helper()
	got, err := s.Now(context.Background(), issue, parseTestUUID(t, f.UserID), pgtype.UUID{}, in)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestWakeupNowStartsAnOrdinaryWakeupRunWithoutAVisibleRule(t *testing.T) {
	f, s, issue, agent := conditionFixture(t)
	ctx := context.Background()
	workspace := parseTestUUID(t, f.WorkspaceID)
	parent := f.Insert(t, "comment", map[string]any{"issue_id": issue, "workspace_id": f.WorkspaceID, "author_type": "member", "author_id": f.UserID, "content": "reply here"})
	f.Cleanup(t, "DELETE FROM comment WHERE id=$1", parent)

	got := wakeNow(t, f, s, issue, WakeupNowInput{AgentID: agent, Instruction: "Rebase the branch", ParentCommentID: parent})
	if got.Outcome != WakeupNowQueued || got.TaskID == "" {
		t.Fatalf("result = %+v", got)
	}
	task, err := f.q.GetAgentTask(ctx, parseTestUUID(t, got.TaskID))
	if err != nil {
		t.Fatal(err)
	}
	var runContext struct {
		WakeupID string `json:"wakeup_id"`
		Hidden   bool   `json:"wakeup_hidden"`
	}
	if err := json.Unmarshal(task.Context, &runContext); err != nil {
		t.Fatal(err)
	}
	if runContext.WakeupID != got.WakeupID || !runContext.Hidden {
		t.Fatalf("run context = %s", task.Context)
	}
	if !strings.Contains(task.HandoffNote.String, "Rebase the branch") || util.UUIDToString(task.TriggerCommentID) != parent {
		t.Fatalf("note=%q trigger_comment=%s", task.HandoffNote.String, util.UUIDToString(task.TriggerCommentID))
	}
	if err := s.CheckClaim(ctx, task); err != nil {
		t.Fatalf("claim check: %v", err)
	}
	rule, err := f.q.LocklessWakeup(ctx, parseTestUUID(t, got.WakeupID))
	if err != nil {
		t.Fatal(err)
	}
	if !rule.Hidden || rule.Enabled || rule.LastTaskID != task.ID || rule.Kind != "at" {
		t.Fatalf("rule = %+v", rule)
	}

	agents := []pgtype.UUID{parseTestUUID(t, agent)}
	listed, err := f.q.ListIssueWakeups(ctx, db.ListIssueWakeupsParams{IssueID: issue, WorkspaceID: workspace, AgentIds: agents})
	if err != nil || len(listed) != 0 {
		t.Fatalf("issue list = %+v err=%v", listed, err)
	}
	if n := f.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND action LIKE 'wakeup%'", issue); n != 0 {
		t.Fatalf("%d timeline entries for a hidden rule", n)
	}
}

func TestWakeupNowIsLeftOutWhileItWaits(t *testing.T) {
	f, s, issue, agent := conditionFixture(t)
	ctx := context.Background()
	first := wakeNow(t, f, s, issue, WakeupNowInput{AgentID: agent, Instruction: "First"})
	// A run of the agent is waiting, so the second input stays on its rule.
	second := wakeNow(t, f, s, issue, WakeupNowInput{AgentID: agent, Instruction: "Second"})
	if first.Outcome != WakeupNowQueued || second.Outcome != WakeupNowPending || second.TaskID != "" {
		t.Fatalf("first=%+v second=%+v", first, second)
	}
	id := parseTestUUID(t, second.WakeupID)
	rule, err := f.q.LocklessWakeup(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if !rule.Enabled {
		t.Fatal("a held rule must stay on until its input is handed over")
	}
	summaries, err := f.q.ListWorkspaceWakeupSummaryRows(ctx, db.ListWorkspaceWakeupSummaryRowsParams{WorkspaceID: parseTestUUID(t, f.WorkspaceID), AgentIds: []pgtype.UUID{parseTestUUID(t, agent)}})
	if err != nil || len(summaries) != 0 {
		t.Fatalf("summaries = %+v err=%v", summaries, err)
	}
	// Once the first run is gone the rule starts its own, as a fired rule does.
	f.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", parseTestUUID(t, first.TaskID))
	wakeDispatch(t, s, rule)
	if n := wakeRuns(t, f, id); n != 1 {
		t.Fatalf("%d runs after the wait, want 1", n)
	}
}

func TestWakeupNowAppliesCreateChecks(t *testing.T) {
	f, s, issue, agent := conditionFixture(t)
	ctx := context.Background()
	member := parseTestUUID(t, f.UserID)
	if _, err := s.Now(ctx, issue, member, pgtype.UUID{}, WakeupNowInput{AgentID: agent, Instruction: "   "}); !errors.Is(err, ErrWakeupInput) {
		t.Errorf("blank instruction: %v", err)
	}
	if _, err := s.Now(ctx, issue, member, pgtype.UUID{}, WakeupNowInput{AgentID: "00000000-0000-0000-0000-000000000001", Instruction: "x"}); !errors.Is(err, ErrWakeupForbidden) {
		t.Errorf("foreign agent: %v", err)
	}
	if _, err := s.Now(ctx, issue, parseTestUUID(t, "00000000-0000-0000-0000-000000000002"), pgtype.UUID{}, WakeupNowInput{AgentID: agent, Instruction: "x"}); !errors.Is(err, ErrWakeupForbidden) {
		t.Errorf("non-member: %v", err)
	}
	wakeSetStatus(t, f, issue, "done")
	if _, err := s.Now(ctx, issue, member, pgtype.UUID{}, WakeupNowInput{AgentID: agent, Instruction: "x"}); !errors.Is(err, ErrWakeupInput) {
		t.Errorf("closed issue: %v", err)
	}
}

func TestWakeupNowRunIsCancelledWhenTheIssueCloses(t *testing.T) {
	f, s, issue, agent := conditionFixture(t)
	got := wakeNow(t, f, s, issue, WakeupNowInput{AgentID: agent, Instruction: "x"})
	wakeSetStatus(t, f, issue, "done")
	task, err := f.q.GetAgentTask(context.Background(), parseTestUUID(t, got.TaskID))
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "cancelled" {
		t.Fatalf("status = %s", task.Status)
	}
}

func TestSweepHiddenWakeupsKeepsWhatARunStillNeeds(t *testing.T) {
	f, s, issue, agent := conditionFixture(t)
	ctx := context.Background()
	old := func(id pgtype.UUID) {
		t.Helper()
		f.Exec(t, "UPDATE issue_wakeup SET updated_at=now()-interval '8 days' WHERE id=$1", id)
	}
	fire := func() (pgtype.UUID, pgtype.UUID) {
		t.Helper()
		got := wakeNow(t, f, s, issue, WakeupNowInput{AgentID: agent, Instruction: "x"})
		if got.Outcome != WakeupNowQueued {
			t.Fatalf("not queued: %+v", got)
		}
		return parseTestUUID(t, got.WakeupID), parseTestUUID(t, got.TaskID)
	}
	finish := func(task pgtype.UUID) {
		t.Helper()
		f.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", task)
	}
	exists := func(id pgtype.UUID) bool {
		t.Helper()
		return f.Count(t, "SELECT count(*) FROM issue_wakeup WHERE id=$1", id) == 1
	}
	sweep := func() {
		t.Helper()
		if _, err := s.SweepHiddenWakeups(ctx, time.Now()); err != nil {
			t.Fatal(err)
		}
	}

	finished, finishedTask := fire()
	finish(finishedTask)
	old(finished)
	active, activeTask := fire()
	old(active)
	sweep()
	if exists(finished) {
		t.Error("finished hidden rule survived the sweep")
	}
	if n := f.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1", finished); n != 0 {
		t.Errorf("%d receipts left behind", n)
	}
	if !exists(active) {
		t.Fatal("swept a rule whose run can still start")
	}
	task, err := f.q.GetAgentTask(ctx, activeTask)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckClaim(ctx, task); err != nil {
		t.Fatalf("waiting run lost its rule: %v", err)
	}
	// A finished run outlives its rule, and only its context still names it.
	if _, err := f.q.GetAgentTask(ctx, finishedTask); err != nil {
		t.Fatalf("finished run: %v", err)
	}

	finish(activeTask)
	recent, recentTask := fire()
	finish(recentTask)
	sweep()
	if !exists(recent) {
		t.Error("swept a rule inside the retention window")
	}

	// An input not handed over yet keeps its rule; visible rules are never swept.
	fire()
	held := wakeNow(t, f, s, issue, WakeupNowInput{AgentID: agent, Instruction: "held"})
	heldID := parseTestUUID(t, held.WakeupID)
	f.Exec(t, "UPDATE issue_wakeup SET enabled=false,updated_at=now()-interval '8 days' WHERE id=$1", heldID)
	visible := wakeCreate(t, f, s, issue, WakeupInput{AgentID: agent, Kind: "event", EventTypes: []string{"comment.created"}, Instruction: "x"})
	f.Exec(t, "UPDATE issue_wakeup SET enabled=false,updated_at=now()-interval '8 days' WHERE id=$1", visible.ID)
	sweep()
	if !exists(heldID) {
		t.Error("swept a rule with an unprocessed input")
	}
	if !exists(visible.ID) {
		t.Error("swept a visible rule")
	}
}
