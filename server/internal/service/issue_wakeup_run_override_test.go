package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

const pinnedContext = `'{"run_override":{"runtime_id":"x","model":"gpt-5","thinking_level":"high"}}'::jsonb`

func staleDispatchCols(issue, runtime, ctx string) testutil.Cols {
	return testutil.Cols{"runtime_id": runtime, "issue_id": issue, "status": "dispatched",
		"dispatched_at": testutil.Raw("now() - interval '10 minutes'"), "prepare_lease_expires_at": testutil.Raw("now() - interval '1 minute'"),
		"context": testutil.Raw(ctx)}
}

// pinnedFixture is a wake fixture plus a second, public seat B the agent is not bound to.
func pinnedFixture(t *testing.T) (principalFixture, *IssueWakeupService, pgtype.UUID, string, string, string) {
	t.Helper()
	f, s, issue, agent := conditionFixture(t)
	seat := f.Runtime(t, "seat-b", testutil.Cols{"visibility": "public", "owner_id": f.UserID})
	row, err := f.q.GetAgent(context.Background(), parseTestUUID(t, agent))
	if err != nil {
		t.Fatal(err)
	}
	return f, s, issue, agent, seat, util.UUIDToString(row.RuntimeID)
}

func nowOverride(t *testing.T, seat string) *RunOverride {
	t.Helper()
	return &RunOverride{RuntimeID: seat, Model: "gpt-5", ThinkingLevel: "high"}
}

func TestPinnedRunPassesQueuedClaimFencesAndOrdinaryRunDoesNot(t *testing.T) {
	f, s, issue, agent, seat, _ := pinnedFixture(t)
	ctx := context.Background()
	other := f.Issue(t, "other")
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", other)
	seatID := parseTestUUID(t, seat)
	pinned := f.Task(t, agent, testutil.Cols{"runtime_id": seat, "issue_id": util.UUIDToString(issue), "status": "queued", "context": testutil.Raw(pinnedContext)})
	plain := f.Task(t, agent, testutil.Cols{"runtime_id": seat, "issue_id": other, "status": "queued"})

	// Both claim-candidate lists admit the pinned run only.
	for name, list := range map[string]func() ([]db.AgentTaskQueue, error){
		"singular": func() ([]db.AgentTaskQueue, error) { return f.q.ListQueuedClaimCandidatesByRuntime(ctx, seatID) },
		"batch": func() ([]db.AgentTaskQueue, error) {
			return f.q.ListQueuedClaimCandidatesByRuntimes(ctx, []pgtype.UUID{seatID})
		},
	} {
		rows, err := list()
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 || util.UUIDToString(rows[0].ID) != pinned {
			t.Fatalf("%s candidates = %+v, want only the pinned run", name, rows)
		}
	}

	claimed, err := s.Tasks.ClaimTaskForRuntime(ctx, seatID)
	if err != nil || claimed == nil || util.UUIDToString(claimed.ID) != pinned {
		t.Fatalf("claim = %+v err=%v, want pinned", claimed, err)
	}
	if !TaskRunPinned(*claimed) {
		t.Fatalf("claimed task not reported pinned: %s", claimed.Context)
	}
	// The ordinary run on the same seat stays refused by the rebind fence.
	next, err := s.Tasks.ClaimTaskForRuntime(ctx, seatID)
	if err != nil || next != nil {
		t.Fatalf("second claim = %+v err=%v, want nil", next, err)
	}
	if status := f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE id=$1 AND status='queued'", plain); status != 1 {
		t.Fatalf("ordinary run was claimed on a foreign seat")
	}
}

func TestPinnedRunClaimDoesNotLeakOntoAgentOwnRuntimeOrAcrossAgents(t *testing.T) {
	f, s, issue, agent, seat, ownRuntime := pinnedFixture(t)
	ctx := context.Background()
	f.Task(t, agent, testutil.Cols{"runtime_id": seat, "issue_id": util.UUIDToString(issue), "status": "queued", "context": testutil.Raw(pinnedContext)})

	got, err := s.Tasks.ClaimTaskForRuntime(ctx, parseTestUUID(t, ownRuntime))
	if err != nil || got != nil {
		t.Fatalf("claim on the agent's own runtime = %+v err=%v, want nil", got, err)
	}
	stranger := f.Runtime(t, "seat-c", testutil.Cols{"visibility": "public", "owner_id": f.UserID})
	got, err = s.Tasks.ClaimTaskForRuntime(ctx, parseTestUUID(t, stranger))
	if err != nil || got != nil {
		t.Fatalf("claim on an unrelated seat = %+v err=%v, want nil", got, err)
	}
}

func TestPinnedRunPassesStaleReclaimFencesAndOrdinaryRunDoesNot(t *testing.T) {
	f, s, issue, agent, seat, _ := pinnedFixture(t)
	ctx := context.Background()
	other := f.Issue(t, "other")
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", other)
	seatID := parseTestUUID(t, seat)
	pinned := f.Task(t, agent, staleDispatchCols(util.UUIDToString(issue), seat, pinnedContext))
	plain := f.Task(t, agent, staleDispatchCols(other, seat, "'{}'::jsonb"))
	reclaimed := func(id string) int {
		return f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE id=$1 AND dispatched_at > now() - interval '1 minute'", id)
	}
	rows, err := s.Tasks.Queries.ReclaimStaleDispatchedTasksForRuntimes(ctx, db.ReclaimStaleDispatchedTasksForRuntimesParams{
		PrepareLeaseSecs: 60, RuntimeIds: []pgtype.UUID{seatID}, ClaimRecoverySecs: 30, RuntimeStaleSecs: RuntimeClaimFreshnessSeconds, MaxTasks: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || util.UUIDToString(rows[0].ID) != pinned || reclaimed(pinned) != 1 {
		t.Fatalf("batch reclaim = %+v, want only the pinned run", rows)
	}
	// Reset and take the singular path; the ordinary run never comes back.
	f.Exec(t, "UPDATE agent_task_queue SET dispatched_at=now()-interval '10 minutes', prepare_lease_expires_at=now()-interval '1 minute' WHERE id=$1", pinned)
	one, err := s.Tasks.Queries.ReclaimStaleDispatchedTaskForRuntime(ctx, db.ReclaimStaleDispatchedTaskForRuntimeParams{
		RuntimeID: seatID, PrepareLeaseSecs: 60, ClaimRecoverySecs: 30, RuntimeStaleSecs: RuntimeClaimFreshnessSeconds})
	if err != nil || util.UUIDToString(one.ID) != pinned {
		t.Fatalf("singular reclaim = %s err=%v", one.ID, err)
	}
	if reclaimed(plain) != 0 {
		t.Fatal("ordinary run was reclaimed on a foreign seat")
	}
}

func TestPrivateRuntimeOwnerCheckStillBindsPinnedRunOnReclaim(t *testing.T) {
	f, s, issue, agent, _, _ := pinnedFixture(t)
	ctx := context.Background()
	stranger := f.User(t, "pin stranger", "pin-stranger@multica.test")
	private := f.Runtime(t, "seat-private", testutil.Cols{"visibility": "private", "owner_id": stranger})
	f.Task(t, agent, staleDispatchCols(util.UUIDToString(issue), private, pinnedContext))

	rows, err := s.Tasks.Queries.ReclaimStaleDispatchedTasksForRuntimes(ctx, db.ReclaimStaleDispatchedTasksForRuntimesParams{
		PrepareLeaseSecs: 60, RuntimeIds: []pgtype.UUID{parseTestUUID(t, private)}, ClaimRecoverySecs: 30, RuntimeStaleSecs: RuntimeClaimFreshnessSeconds, MaxTasks: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("pinned run passed the private-runtime owner fence: %+v", rows)
	}
}

func TestFailoverRestampSkipsPinnedRuns(t *testing.T) {
	f, s, issue, agent, seat, _ := pinnedFixture(t)
	ctx := context.Background()
	other := f.Issue(t, "other")
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", other)
	dest := f.Runtime(t, "failover-dest", testutil.Cols{"visibility": "public", "owner_id": f.UserID})
	pinned := f.Task(t, agent, testutil.Cols{"runtime_id": seat, "issue_id": util.UUIDToString(issue), "status": "queued", "context": testutil.Raw(pinnedContext)})
	plain := f.Task(t, agent, testutil.Cols{"runtime_id": seat, "issue_id": other, "status": "queued"})

	got, err := s.Tasks.Queries.ReassignPendingAgentTasksToRuntime(ctx, db.ReassignPendingAgentTasksToRuntimeParams{AgentID: parseTestUUID(t, agent), NewRuntimeID: parseTestUUID(t, dest)})
	if err != nil || !got.FenceOk || got.ReassignedTasks != 1 {
		t.Fatalf("reassign = %+v err=%v", got, err)
	}
	var pinnedRT, plainRT string
	f.QueryRow(t, "SELECT runtime_id::text FROM agent_task_queue WHERE id=$1", pinned).Scan(&pinnedRT)
	f.QueryRow(t, "SELECT runtime_id::text FROM agent_task_queue WHERE id=$1", plain).Scan(&plainRT)
	if pinnedRT != seat || plainRT != dest {
		t.Fatalf("pinned=%s (want %s), plain=%s (want %s)", pinnedRT, seat, plainRT, dest)
	}
}

func TestQueuedSweepFailsPinnedWakeupRunButNotOrdinaryWakeupRun(t *testing.T) {
	f, s, issue, agent, seat, _ := pinnedFixture(t)
	ctx := context.Background()
	other := f.Issue(t, "other")
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", other)
	f.Exec(t, "UPDATE agent_runtime SET status='offline', last_seen_at=now()-interval '2 hours' WHERE id=$1", seat)
	pinned := f.Task(t, agent, testutil.Cols{"runtime_id": seat, "issue_id": util.UUIDToString(issue), "status": "queued",
		"created_at": testutil.Raw("now()-interval '2 hours'"),
		"context":    testutil.Raw(`'{"wakeup_id":"00000000-0000-0000-0000-000000000000","wakeup_revision":1,"run_override":{"runtime_id":"x","model":"","thinking_level":""}}'::jsonb`)})
	wakeup := f.Task(t, agent, testutil.Cols{"runtime_id": seat, "issue_id": other, "status": "queued",
		"created_at": testutil.Raw("now()-interval '2 hours'"),
		"context":    testutil.Raw(`'{"wakeup_id":"00000000-0000-0000-0000-000000000000","wakeup_revision":1}'::jsonb`)})
	failed, err := s.Tasks.Queries.ExpireStaleQueuedTasks(ctx, db.ExpireStaleQueuedTasksParams{ReconnectGraceSecs: 300, MaxPerTick: 100})
	if err != nil {
		t.Fatal(err)
	}
	var sawPinned, sawWakeup bool
	for _, row := range failed {
		sawPinned = sawPinned || util.UUIDToString(row.ID) == pinned
		sawWakeup = sawWakeup || util.UUIDToString(row.ID) == wakeup
	}
	if !sawPinned || sawWakeup {
		t.Fatalf("sweep pinned=%v (want true) ordinary wakeup=%v (want false)", sawPinned, sawWakeup)
	}
}

func TestGetLastTaskSessionSkipsPinnedRunsUnlessClaimingRunIsPinned(t *testing.T) {
	f, s, issue, agent, seat, ownRuntime := pinnedFixture(t)
	ctx := context.Background()
	issueStr := util.UUIDToString(issue)
	f.Task(t, agent, testutil.Cols{"runtime_id": ownRuntime, "issue_id": issueStr, "status": "completed", "session_id": "own", "completed_at": testutil.Raw("now()-interval '1 hour'")})
	f.Task(t, agent, testutil.Cols{"runtime_id": seat, "issue_id": issueStr, "status": "completed", "session_id": "pinned", "completed_at": testutil.Raw("now()"), "context": testutil.Raw(pinnedContext)})
	params := db.GetLastTaskSessionParams{AgentID: parseTestUUID(t, agent), IssueID: issue}
	row, err := s.Tasks.Queries.GetLastTaskSession(ctx, params)
	if err != nil || row.SessionID.String != "own" {
		t.Fatalf("ordinary run resumes %q err=%v, want own", row.SessionID.String, err)
	}
	params.IncludePinned = true
	row, err = s.Tasks.Queries.GetLastTaskSession(ctx, params)
	if err != nil || row.SessionID.String != "pinned" {
		t.Fatalf("pinned retry resumes %q err=%v, want pinned", row.SessionID.String, err)
	}
}

func TestWakeupNowOverrideQueuesAPinnedFreshRun(t *testing.T) {
	f, s, issue, agent, seat, _ := pinnedFixture(t)
	ctx := context.Background()

	got := wakeNow(t, f, s, issue, WakeupNowInput{AgentID: agent, Instruction: "audit", RunOverride: nowOverride(t, seat)})
	if got.Outcome != WakeupNowQueued || got.TaskID == "" {
		t.Fatalf("result = %+v", got)
	}
	task, err := f.q.GetAgentTask(ctx, parseTestUUID(t, got.TaskID))
	if err != nil {
		t.Fatal(err)
	}
	if util.UUIDToString(task.RuntimeID) != seat || !task.ForceFreshSession {
		t.Fatalf("task runtime=%s fresh=%v", util.UUIDToString(task.RuntimeID), task.ForceFreshSession)
	}
	override := TaskRunOverride(task)
	if override == nil || override.Model != "gpt-5" || override.ThinkingLevel != "high" {
		t.Fatalf("override = %+v context=%s", override, task.Context)
	}
	if err := s.CheckClaim(ctx, task); err != nil {
		t.Fatalf("claim check: %v", err)
	}
	rule, err := f.q.LocklessWakeup(ctx, parseTestUUID(t, got.WakeupID))
	if err != nil {
		t.Fatal(err)
	}
	var stored RunOverride
	if err := json.Unmarshal(rule.RunOverride, &stored); err != nil || stored.RuntimeID != seat {
		t.Fatalf("rule override = %s err=%v", rule.RunOverride, err)
	}
}

func TestWakeupNowOverrideIsRefusedWhenARunOfTheAgentIsWaitingOrTheSeatIsOffline(t *testing.T) {
	f, s, issue, agent, seat, own := pinnedFixture(t)
	ctx := context.Background()
	member := parseTestUUID(t, f.UserID)
	in := WakeupNowInput{AgentID: agent, Instruction: "audit", RunOverride: nowOverride(t, seat)}

	// Queued as someone else: still blocks, and is never joined.
	someone := f.User(t, "waiter", "pin-waiter@multica.test")
	task := f.Task(t, agent, testutil.Cols{"runtime_id": own, "issue_id": util.UUIDToString(issue), "status": "queued", "originator_user_id": someone, "accountable_user_id": someone})
	if _, err := s.Now(ctx, issue, member, pgtype.UUID{}, in); !errors.Is(err, ErrRunOverrideUnavailable) {
		t.Fatalf("waiting run: err = %v", err)
	}
	if rules := f.Count(t, "SELECT count(*) FROM issue_wakeup WHERE issue_id=$1", issue); rules != 0 {
		t.Fatalf("a refused override left %d rule(s)", rules)
	}
	f.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", task)

	f.Exec(t, "UPDATE agent_runtime SET status='offline' WHERE id=$1", seat)
	if _, err := s.Now(ctx, issue, member, pgtype.UUID{}, in); !errors.Is(err, ErrRunOverrideUnavailable) {
		t.Fatalf("offline seat: err = %v", err)
	}
	f.Exec(t, "UPDATE agent_runtime SET status='online', last_seen_at=now()-interval '1 hour' WHERE id=$1", seat)
	if _, err := s.Now(ctx, issue, member, pgtype.UUID{}, in); !errors.Is(err, ErrRunOverrideUnavailable) {
		t.Fatalf("stale heartbeat: err = %v", err)
	}
}

func TestPinnedWakeupNeverJoinsAWaitingRunAndAPinnedRunTakesNoOneElse(t *testing.T) {
	f, s, issue, agent, seat, _ := pinnedFixture(t)
	ctx := context.Background()
	member := parseTestUUID(t, f.UserID)
	// A deferred dispatch: the rule exists but its input has not produced a run.
	rule := wakeCreate(t, f, s, issue, WakeupInput{AgentID: agent, Instruction: "plain", Kind: "at", Mode: "once", AfterSeconds: 60})
	f.Exec(t, "UPDATE issue_wakeup SET run_override=$2 WHERE id=$1", rule.ID, `{"runtime_id":"`+seat+`","model":"m","thinking_level":""}`)
	if _, err := f.q.RecordWakeupReceipt(ctx, db.RecordWakeupReceiptParams{ID: dbid.NewV7(), WakeupID: rule.ID, Revision: rule.Revision, EventKey: "k1", EventType: wakeupManualEventType, Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	waiting, err := f.q.ListWaitingWakeups(ctx, db.ListWaitingWakeupsParams{IssueID: issue, AgentID: parseTestUUID(t, agent)})
	if err != nil || len(waiting) != 0 {
		t.Fatalf("pinned rule listed for joining: %v err=%v", waiting, err)
	}

	// An ordinary rule's inputs must not ride on a pinned run being claimed.
	plainRule := wakeCreate(t, f, s, issue, WakeupInput{AgentID: agent, Instruction: "plain", Kind: "at", Mode: "once", AfterSeconds: 60})
	if _, err := f.q.RecordWakeupReceipt(ctx, db.RecordWakeupReceiptParams{ID: dbid.NewV7(), WakeupID: plainRule.ID, Revision: plainRule.Revision, EventKey: "k2", EventType: wakeupManualEventType, Payload: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	waiting, err = f.q.ListWaitingWakeups(ctx, db.ListWaitingWakeupsParams{IssueID: issue, AgentID: parseTestUUID(t, agent)})
	if err != nil || len(waiting) != 1 || waiting[0] != plainRule.ID {
		t.Fatalf("waiting = %v err=%v, want only the plain rule", waiting, err)
	}
	pinned := db.AgentTaskQueue{IssueID: issue, OriginatorUserID: member, AgentID: parseTestUUID(t, agent), Status: "dispatched", Context: []byte(`{"run_override":{"runtime_id":"x"}}`)}
	out, err := s.JoinWaitingWakeups(ctx, pinned)
	if err != nil || string(out) != string(pinned.Context) {
		t.Fatalf("pinned claim joined: %s err=%v", out, err)
	}
}

func TestPinnedRuleCannotBeRetriggeredOrReenabledAndRetryStaysOnSeat(t *testing.T) {
	f, s, issue, agent, seat, _ := pinnedFixture(t)
	ctx := context.Background()
	member := parseTestUUID(t, f.UserID)
	got := wakeNow(t, f, s, issue, WakeupNowInput{AgentID: agent, Instruction: "audit", RunOverride: nowOverride(t, seat)})
	ruleID := parseTestUUID(t, got.WakeupID)
	rule, err := f.q.LocklessWakeup(ctx, ruleID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Trigger(ctx, issue, ruleID, member); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("trigger err = %v", err)
	}
	if _, err := s.Save(ctx, issue, member, pgtype.UUID{}, ruleID, WakeupInput{AgentID: agent, Instruction: "x", Kind: "at", Mode: "once", AfterSeconds: 60}); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("update err = %v", err)
	}

	// Automatic retry: failed attempt keeps runtime, context and the seat.
	task := parseTestUUID(t, got.TaskID)
	f.Exec(t, "UPDATE agent_task_queue SET status='failed', session_id='sess', completed_at=now() WHERE id=$1", got.TaskID)
	if _, err := s.Enable(ctx, issue, member, pgtype.UUID{}, ruleID, WakeupEnableInput{Revision: rule.Revision, Rearm: true}); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("enable err = %v", err)
	}
	retry, err := f.q.CreateRetryTask(ctx, db.CreateRetryTaskParams{ID: task, NewTaskID: dbid.NewV7()})
	if err != nil {
		t.Fatal(err)
	}
	if util.UUIDToString(retry.RuntimeID) != seat || !TaskRunPinned(retry) || retry.SessionID.String != "sess" {
		t.Fatalf("retry runtime=%s pinned=%v session=%q", util.UUIDToString(retry.RuntimeID), TaskRunPinned(retry), retry.SessionID.String)
	}
}
