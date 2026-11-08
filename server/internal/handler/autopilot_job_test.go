package handler

// Contango patch 22: autopilot ops jobs — create/update validation, firing a
// job via run now, and the runner API (list / claim / finish).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func createJobAutopilot(t *testing.T, jobName string) AutopilotResponse {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.CreateAutopilot(w, newRequest("POST", "/api/autopilots", map[string]any{
		"title":          "Ops job " + jobName,
		"execution_mode": "job",
		"job_name":       jobName,
	}))
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateAutopilot(job): want 201, got %d: %s", w.Code, w.Body.String())
	}
	var ap AutopilotResponse
	json.NewDecoder(w.Body).Decode(&ap)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM autopilot WHERE id = $1`, ap.ID)
	})
	return ap
}

func runNow(t *testing.T, apID string) AutopilotRunResponse {
	t.Helper()
	w := httptest.NewRecorder()
	r := withURLParam(newRequest("POST", "/api/autopilots/"+apID+"/trigger", nil), "id", apID)
	testHandler.TriggerAutopilot(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("TriggerAutopilot: want 200, got %d: %s", w.Code, w.Body.String())
	}
	var run AutopilotRunResponse
	json.NewDecoder(w.Body).Decode(&run)
	return run
}

func claimJobRun(runID string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := withURLParam(newRequest("POST", "/api/autopilot/job-runs/"+runID+"/claim", nil), "runId", runID)
	testHandler.ClaimAutopilotJobRun(w, r)
	return w
}

func finishJobRun(runID string, body any) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := withURLParam(newRequest("POST", "/api/autopilot/job-runs/"+runID+"/finish", body), "runId", runID)
	testHandler.FinishAutopilotJobRun(w, r)
	return w
}

func listPendingJobRuns(t *testing.T) []AutopilotJobRunResponse {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.ListAutopilotJobRuns(w, newRequest("GET", "/api/autopilot/job-runs?status=pending", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("ListAutopilotJobRuns: want 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Runs []AutopilotJobRunResponse `json:"runs"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	return resp.Runs
}

func TestAutopilotJobCreateValidation(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "autopilot-job-validation-agent", []byte(`[]`))
	cases := []struct {
		name string
		body map[string]any
	}{
		{"missing job_name", map[string]any{"title": "x", "execution_mode": "job"}},
		{"bad job_name", map[string]any{"title": "x", "execution_mode": "job", "job_name": "Bad Name"}},
		{"job with assignee", map[string]any{"title": "x", "execution_mode": "job", "job_name": "explore", "assignee_id": agentID}},
		{"job_name on agent mode", map[string]any{"title": "x", "execution_mode": "run_only", "assignee_id": agentID, "job_name": "explore"}},
		{"unknown mode", map[string]any{"title": "x", "execution_mode": "cron", "job_name": "explore"}},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		testHandler.CreateAutopilot(w, newRequest("POST", "/api/autopilots", tc.body))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d: %s", tc.name, w.Code, w.Body.String())
		}
	}

	ap := createJobAutopilot(t, "explore")
	if ap.ExecutionMode != "job" || ap.JobName == nil || *ap.JobName != "explore" || ap.AssigneeID != "" {
		t.Fatalf("job autopilot response: mode=%q job_name=%v assignee=%q", ap.ExecutionMode, ap.JobName, ap.AssigneeID)
	}

	// Webhook triggers are refused on a job.
	w := httptest.NewRecorder()
	r := withURLParam(newRequest("POST", "/api/autopilots/"+ap.ID+"/triggers", map[string]any{"kind": "webhook"}), "id", ap.ID)
	testHandler.CreateAutopilotTrigger(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("webhook trigger on job: want 400, got %d: %s", w.Code, w.Body.String())
	}

	// Leaving job mode needs an assignee; with one, job_name is cleared.
	patch := func(body map[string]any) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		testHandler.UpdateAutopilot(w, withURLParam(newRequest("PATCH", "/api/autopilots/"+ap.ID, body), "id", ap.ID))
		return w
	}
	if w := patch(map[string]any{"execution_mode": "run_only"}); w.Code != http.StatusBadRequest {
		t.Fatalf("leave job mode without assignee: want 400, got %d: %s", w.Code, w.Body.String())
	}
	if w := patch(map[string]any{"job_name": "pr-watch"}); w.Code != http.StatusOK {
		t.Fatalf("rename job: want 200, got %d: %s", w.Code, w.Body.String())
	}
	w = patch(map[string]any{"execution_mode": "run_only", "assignee_type": "agent", "assignee_id": agentID})
	if w.Code != http.StatusOK {
		t.Fatalf("leave job mode: want 200, got %d: %s", w.Code, w.Body.String())
	}
	var out AutopilotResponse
	json.NewDecoder(w.Body).Decode(&out)
	if out.JobName != nil || out.AssigneeID != agentID {
		t.Fatalf("after leaving job mode: job_name=%v assignee=%q", out.JobName, out.AssigneeID)
	}
	// And back: the assignee is dropped.
	w = patch(map[string]any{"execution_mode": "job", "job_name": "explore"})
	if w.Code != http.StatusOK {
		t.Fatalf("enter job mode: want 200, got %d: %s", w.Code, w.Body.String())
	}
	json.NewDecoder(w.Body).Decode(&out)
	if out.AssigneeID != "" || out.JobName == nil || *out.JobName != "explore" {
		t.Fatalf("after entering job mode: job_name=%v assignee=%q", out.JobName, out.AssigneeID)
	}
}

func TestAutopilotJobRunLifecycle(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	ap := createJobAutopilot(t, "wiki-sync")

	run := runNow(t, ap.ID)
	if run.Status != "pending" {
		t.Fatalf("run now on a job: want pending, got %q", run.Status)
	}
	var issues, tasks int
	testPool.QueryRow(ctx, `SELECT count(*) FROM issue WHERE origin_id = $1`, ap.ID).Scan(&issues)
	testPool.QueryRow(ctx, `SELECT count(*) FROM agent_task_queue WHERE autopilot_run_id = $1`, run.ID).Scan(&tasks)
	if issues != 0 || tasks != 0 {
		t.Fatalf("job run must create no issue/task: issues=%d tasks=%d", issues, tasks)
	}

	// Overlap: a second fire while the first is pending is skipped.
	if second := runNow(t, ap.ID); second.Status != "skipped" {
		t.Fatalf("overlapping fire: want skipped, got %q", second.Status)
	}

	var listed *AutopilotJobRunResponse
	for _, r := range listPendingJobRuns(t) {
		if r.ID == run.ID {
			r := r
			listed = &r
		}
	}
	if listed == nil || listed.JobName != "wiki-sync" || listed.AutopilotID != ap.ID || listed.FiredAt == "" {
		t.Fatalf("pending list: want run %s with job_name wiki-sync, got %+v", run.ID, listed)
	}

	// Finish before claim is a conflict.
	if w := finishJobRun(run.ID, map[string]any{"status": "succeeded"}); w.Code != http.StatusConflict {
		t.Fatalf("finish pending: want 409, got %d: %s", w.Code, w.Body.String())
	}

	// Claim is atomic: of N concurrent claims exactly one wins.
	const n = 8
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = claimJobRun(run.ID).Code
		}(i)
	}
	wg.Wait()
	wins, conflicts := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			wins++
		case http.StatusConflict:
			conflicts++
		}
	}
	if wins != 1 || conflicts != n-1 {
		t.Fatalf("concurrent claims: want 1x200 and %dx409, got %v", n-1, codes)
	}

	// Finish validates its body.
	for _, body := range []map[string]any{{"status": "done"}, {}, {"status": "completed"}} {
		if w := finishJobRun(run.ID, body); w.Code != http.StatusBadRequest {
			t.Fatalf("finish %v: want 400, got %d: %s", body, w.Code, w.Body.String())
		}
	}

	long := "HEAD-" + strings.Repeat("x", 9000) + "-TAIL"
	w := finishJobRun(run.ID, map[string]any{"status": "failed", "exit_code": 3, "output_tail": long})
	if w.Code != http.StatusOK {
		t.Fatalf("finish: want 200, got %d: %s", w.Code, w.Body.String())
	}
	var finished AutopilotJobRunResponse
	json.NewDecoder(w.Body).Decode(&finished)
	if finished.Status != "failed" || finished.ExitCode == nil || *finished.ExitCode != 3 || finished.FinishedAt == nil || finished.StartedAt == nil {
		t.Fatalf("finished run: %+v", finished)
	}
	var tail, reason string
	testPool.QueryRow(ctx, `SELECT output_tail, failure_reason FROM autopilot_run WHERE id = $1`, run.ID).Scan(&tail, &reason)
	if len(tail) != 8192 || !strings.HasSuffix(tail, "-TAIL") || strings.HasPrefix(tail, "HEAD") {
		t.Fatalf("output_tail: want the last 8192 bytes, got len %d", len(tail))
	}
	if reason != "ops job failed (exit code 3)" {
		t.Fatalf("failure_reason: got %q", reason)
	}
	// Finishing twice is a conflict.
	if w := finishJobRun(run.ID, map[string]any{"status": "succeeded"}); w.Code != http.StatusConflict {
		t.Fatalf("second finish: want 409, got %d: %s", w.Code, w.Body.String())
	}

	// The run history carries the runner's fields.
	w = httptest.NewRecorder()
	testHandler.ListAutopilotRuns(w, withURLParam(newRequest("GET", "/api/autopilots/"+ap.ID+"/runs", nil), "id", ap.ID))
	var hist struct {
		Runs []AutopilotRunResponse `json:"runs"`
	}
	json.NewDecoder(w.Body).Decode(&hist)
	found := false
	for _, r := range hist.Runs {
		if r.ID == run.ID {
			found = r.OutputTail != nil && r.ExitCode != nil && r.StartedAt != nil
		}
	}
	if !found {
		t.Fatalf("run history lacks output_tail/exit_code/started_at for %s", run.ID)
	}

	// succeeded maps to completed.
	run2 := runNow(t, ap.ID)
	if c := claimJobRun(run2.ID).Code; c != http.StatusOK {
		t.Fatalf("claim run2: %d", c)
	}
	w = finishJobRun(run2.ID, map[string]any{"status": "succeeded", "exit_code": 0, "output_tail": "ok"})
	json.NewDecoder(w.Body).Decode(&finished)
	if w.Code != http.StatusOK || finished.Status != "completed" {
		t.Fatalf("finish succeeded: %d %+v", w.Code, finished)
	}
}

func TestAutopilotJobRunExpiry(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	ap := createJobAutopilot(t, "stall-watch")

	stale := runNow(t, ap.ID)
	testPool.Exec(ctx, `UPDATE autopilot_run SET triggered_at = now() - interval '11 minutes' WHERE id = $1`, stale.ID)

	// Claiming a stale pending run is refused and expires it.
	w := claimJobRun(stale.ID)
	if w.Code != http.StatusConflict {
		t.Fatalf("claim stale run: want 409, got %d: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	json.NewDecoder(w.Body).Decode(&body)
	if body["status"] != "expired" {
		t.Fatalf("claim stale run: want status expired, got %v", body["status"])
	}

	// An expired run no longer blocks the next fire.
	next := runNow(t, ap.ID)
	if next.Status != "pending" {
		t.Fatalf("fire after expiry: want pending, got %q", next.Status)
	}

	// The list expires stale runs too.
	testPool.Exec(ctx, `UPDATE autopilot_run SET triggered_at = now() - interval '11 minutes' WHERE id = $1`, next.ID)
	for _, r := range listPendingJobRuns(t) {
		if r.ID == next.ID {
			t.Fatalf("stale run %s still listed as pending", next.ID)
		}
	}
	var status string
	testPool.QueryRow(ctx, `SELECT status FROM autopilot_run WHERE id = $1`, next.ID).Scan(&status)
	if status != "expired" {
		t.Fatalf("listed stale run: want expired, got %q", status)
	}

	// The periodic sweep path.
	third := runNow(t, ap.ID)
	testPool.Exec(ctx, `UPDATE autopilot_run SET triggered_at = now() - interval '11 minutes' WHERE id = $1`, third.ID)
	if n, err := testHandler.AutopilotService.ExpireStaleAutopilotJobRuns(ctx, pgtype.UUID{}, pgtype.UUID{}); err != nil || n < 1 {
		t.Fatalf("sweep: n=%d err=%v", n, err)
	}
}

func TestAutopilotJobRunRefusesAgentTokens(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ap := createJobAutopilot(t, "inbox-feeder")
	run := runNow(t, ap.ID)

	asAgent := func(r *http.Request) *http.Request {
		r.Header.Set("X-Actor-Source", "task_token")
		return r
	}
	calls := []struct {
		name string
		fn   func(http.ResponseWriter, *http.Request)
		req  *http.Request
	}{
		{"list", testHandler.ListAutopilotJobRuns, asAgent(newRequest("GET", "/api/autopilot/job-runs", nil))},
		{"claim", testHandler.ClaimAutopilotJobRun, asAgent(withURLParam(newRequest("POST", "/x", nil), "runId", run.ID))},
		{"finish", testHandler.FinishAutopilotJobRun, asAgent(withURLParam(newRequest("POST", "/x", map[string]any{"status": "succeeded"}), "runId", run.ID))},
	}
	for _, c := range calls {
		w := httptest.NewRecorder()
		c.fn(w, c.req)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s with a task token: want 403, got %d", c.name, w.Code)
		}
	}
	// The run is untouched.
	if c := claimJobRun(run.ID).Code; c != http.StatusOK {
		t.Fatalf("member claim after refused agent calls: want 200, got %d", c)
	}

	// The router guard refuses too.
	w := httptest.NewRecorder()
	RequireHumanActor(http.HandlerFunc(testHandler.ListAutopilotJobRuns)).ServeHTTP(w, asAgent(newRequest("GET", "/api/autopilot/job-runs", nil)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("router guard: want 403, got %d", w.Code)
	}
}

// An agent must not be able to create, change, schedule, fire or archive a job
// autopilot: job_name selects a privileged command on the ops box.
func TestAutopilotJobRefusesAgentWrites(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ap := createJobAutopilot(t, "agent-refused")
	asAgent := func(r *http.Request) *http.Request {
		r.Header.Set("X-Actor-Source", "task_token")
		return r
	}
	onAP := func(r *http.Request) *http.Request { return asAgent(withURLParam(r, "id", ap.ID)) }
	calls := []struct {
		name string
		fn   func(http.ResponseWriter, *http.Request)
		req  *http.Request
	}{
		{"create", testHandler.CreateAutopilot, asAgent(newRequest("POST", "/api/autopilots", map[string]any{
			"title": "Agent job", "execution_mode": "job", "job_name": "agent-made",
		}))},
		{"update", testHandler.UpdateAutopilot, onAP(newRequest("PATCH", "/x", map[string]any{"job_name": "other-job"}))},
		{"run now", testHandler.TriggerAutopilot, onAP(newRequest("POST", "/x", nil))},
		{"add schedule", testHandler.CreateAutopilotTrigger, onAP(newRequest("POST", "/x", map[string]any{
			"kind": "schedule", "cron_expression": "* * * * *",
		}))},
		{"archive", testHandler.DeleteAutopilot, onAP(newRequest("DELETE", "/x", nil))},
	}
	for _, c := range calls {
		w := httptest.NewRecorder()
		c.fn(w, c.req)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "human actors") {
			t.Errorf("%s with a task token: want 403 human-only, got %d: %s", c.name, w.Code, w.Body.String())
		}
	}
	var runs, active int
	testPool.QueryRow(context.Background(), `SELECT count(*) FROM autopilot_run WHERE autopilot_id = $1`, ap.ID).Scan(&runs)
	testPool.QueryRow(context.Background(), `SELECT count(*) FROM autopilot WHERE id = $1 AND status = 'active' AND job_name = 'agent-refused'`, ap.ID).Scan(&active)
	if runs != 0 || active != 1 {
		t.Fatalf("refused calls changed the autopilot: runs=%d active=%d", runs, active)
	}
	// A member still can.
	runNow(t, ap.ID)
}

func TestAutopilotJobRunUnknownAndAgentRuns404(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "autopilot-job-404-agent", []byte(`[]`))
	apID := insertListTestAutopilot(t, agentID, "job-404-agent-autopilot")
	var agentRun string
	testPool.QueryRow(context.Background(),
		`INSERT INTO autopilot_run (autopilot_id, source, status) VALUES ($1, 'manual', 'issue_created') RETURNING id`, apID).Scan(&agentRun)

	for _, id := range []string{agentRun, "00000000-0000-0000-0000-000000000001"} {
		if c := claimJobRun(id).Code; c != http.StatusNotFound {
			t.Errorf("claim %s: want 404, got %d", id, c)
		}
		if c := finishJobRun(id, map[string]any{"status": "succeeded"}).Code; c != http.StatusNotFound {
			t.Errorf("finish %s: want 404, got %d", id, c)
		}
	}
}
