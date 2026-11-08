package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func runAskCommand(t *testing.T, args []string, handle http.HandlerFunc) {
	t.Helper()
	t.Chdir(t.TempDir())
	srv := httptest.NewServer(handle)
	t.Cleanup(srv.Close)
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")
	cmd := newIssueAskCommand()
	cmd.SetArgs(args)
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
}

const askCLIIssue = "a57c0511-1ebc-471d-a314-438ca16cc75d"

func TestIssueAskCreateSendsDecisionAsk(t *testing.T) {
	var body map[string]any
	runAskCommand(t, []string{"create", askCLIIssue, "--to", "@ana", "--kind", "decision", "--topic", "Which copy?",
		"--reply", "agree", "--reply", "Push back=disagree", "--default", "agree", "--reversible", "--where", "the story"},
		func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodGet && r.URL.Path == "/api/workspaces/ws-1/members":
				_ = json.NewEncoder(w).Encode([]map[string]any{{"user_id": "11111111-1111-1111-1111-111111111111", "name": "Ana", "email": "ana@example.com"}})
			case r.Method == http.MethodPost && r.URL.Path == "/api/issues/"+askCLIIssue+"/asks":
				_ = json.NewDecoder(r.Body).Decode(&body)
				_ = json.NewEncoder(w).Encode(map[string]any{"ask": map[string]any{"id": "ask-1"}})
			default:
				t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			}
		})
	if body["addressee_type"] != "member" || body["addressee_id"] != "11111111-1111-1111-1111-111111111111" || body["kind"] != "decision" ||
		body["topic"] != "Which copy?" || body["default_option"] != "agree" || body["reversible"] != true || body["where"] != "the story" {
		t.Fatalf("unexpected body %+v", body)
	}
	options := body["options"].([]any)
	if len(options) != 2 {
		t.Fatalf("options: %+v", options)
	}
	if second := options[1].(map[string]any); second["label"] != "Push back" || second["reply"] != "disagree" {
		t.Fatalf("label=reply not split: %+v", second)
	}
}

func TestIssueAskCreateOperatorForm(t *testing.T) {
	var body map[string]any
	runAskCommand(t, []string{"create", askCLIIssue, "--to", "operator", "--topic", "seat-3 is down",
		"--last-line", "exit 1", "--diagnosis", "disk full", "--fix", "resize"},
		func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != "/api/issues/"+askCLIIssue+"/asks" {
				t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			_ = json.NewEncoder(w).Encode(map[string]any{"ask": map[string]any{"id": "ask-1"}})
		})
	if body["addressee_type"] != "role" || body["addressee_role"] != "operator" || body["kind"] != "operator" ||
		body["last_line"] != "exit 1" || body["diagnosis"] != "disk full" || body["fix"] != "resize" {
		t.Fatalf("unexpected body %+v", body)
	}
}

func TestIssueAskResolveSendsVia(t *testing.T) {
	var body map[string]any
	runAskCommand(t, []string{"resolve", "ask-1", "--via", "ops", "--text", "fixed the disk"},
		func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != "/api/asks/ask-1/resolve" {
				t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "ask-1"})
		})
	if body["answered_via"] != "ops" || body["answer_text"] != "fixed the disk" {
		t.Fatalf("unexpected body %+v", body)
	}
}
