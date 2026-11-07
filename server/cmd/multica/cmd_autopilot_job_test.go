package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunAutopilotCreateJobMode(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&body)
		json.NewEncoder(w).Encode(map[string]any{"id": "ap-1", "title": "PR watch"})
	}))
	defer srv.Close()
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")

	cmd := newAutopilotCreateTestCmd()
	cmd.Flags().String("execution-mode", "", "")
	cmd.Flags().String("job-name", "", "")
	_ = cmd.Flags().Set("title", "PR watch")
	_ = cmd.Flags().Set("execution-mode", "job")
	_ = cmd.Flags().Set("job-name", "pr-watch")
	if err := runAutopilotCreate(cmd, nil); err != nil {
		t.Fatalf("runAutopilotCreate: %v", err)
	}
	if body["execution_mode"] != "job" || body["job_name"] != "pr-watch" {
		t.Fatalf("body = %#v", body)
	}
	if _, ok := body["assignee_id"]; ok {
		t.Fatalf("job create must not send assignee_id: %#v", body)
	}

	bad := newAutopilotCreateTestCmd()
	bad.Flags().String("execution-mode", "", "")
	bad.Flags().String("job-name", "", "")
	_ = bad.Flags().Set("title", "x")
	_ = bad.Flags().Set("mode", "job")
	if err := runAutopilotCreate(bad, nil); err == nil || !strings.Contains(err.Error(), "--job-name") {
		t.Fatalf("job without --job-name: err = %v", err)
	}
}

func TestAutopilotJobRunsCommands(t *testing.T) {
	var gotPath, gotQuery string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.Method+" "+r.URL.Path, r.URL.RawQuery
		body = nil
		json.NewDecoder(r.Body).Decode(&body)
		if strings.HasSuffix(r.URL.Path, "/job-runs") {
			json.NewEncoder(w).Encode(map[string]any{"runs": []any{}, "total": 0})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "run-1", "status": "running"})
	}))
	defer srv.Close()
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")

	list := *autopilotJobRunsListCmd
	list.ResetFlags()
	list.Flags().String("status", "pending", "")
	list.Flags().Int("limit", 0, "")
	list.Flags().String("output", "json", "")
	if err := runAutopilotJobRunsList(&list, nil); err != nil {
		t.Fatalf("list: %v", err)
	}
	if gotPath != "GET /api/autopilot/job-runs" || gotQuery != "status=pending" {
		t.Fatalf("list request = %s ?%s", gotPath, gotQuery)
	}

	claim := *autopilotJobRunsClaimCmd
	claim.ResetFlags()
	claim.Flags().String("output", "json", "")
	if err := runAutopilotJobRunsClaim(&claim, []string{"run-1"}); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if gotPath != "POST /api/autopilot/job-runs/run-1/claim" {
		t.Fatalf("claim request = %s", gotPath)
	}

	finish := *autopilotJobRunsFinishCmd
	finish.ResetFlags()
	finish.Flags().String("status", "", "")
	finish.Flags().Int("exit-code", 0, "")
	finish.Flags().String("output-tail", "", "")
	finish.Flags().String("output-tail-file", "", "")
	finish.Flags().String("output", "json", "")
	_ = finish.Flags().Set("status", "failed")
	_ = finish.Flags().Set("exit-code", "2")
	_ = finish.Flags().Set("output-tail", strings.Repeat("é", 5000))
	if err := runAutopilotJobRunsFinish(&finish, []string{"run-1"}); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if gotPath != "POST /api/autopilot/job-runs/run-1/finish" || body["status"] != "failed" || body["exit_code"] != float64(2) {
		t.Fatalf("finish request = %s %#v", gotPath, body)
	}
	if tail, _ := body["output_tail"].(string); len(tail) > 8192 || len(tail) < 8190 {
		t.Fatalf("output_tail len = %d", len(tail))
	}

	bad := *autopilotJobRunsFinishCmd
	bad.ResetFlags()
	bad.Flags().String("status", "", "")
	_ = bad.Flags().Set("status", "done")
	if err := runAutopilotJobRunsFinish(&bad, []string{"run-1"}); err == nil {
		t.Fatalf("finish --status done: want error")
	}
}
