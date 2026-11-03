package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
)

// Contango: `issue create --from-comment` and `issue set-source`.

func TestRunIssueCreateSendsSourceCommentWithoutTouchingParent(t *testing.T) {
	t.Chdir(t.TempDir())
	commentID := uuid.NewString()
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/config":
			json.NewEncoder(w).Encode(map[string]any{})
		case "/api/issues":
			json.NewDecoder(r.Body).Decode(&body)
			json.NewEncoder(w).Encode(map[string]any{"id": "issue-1", "identifier": "MUL-1", "title": "Card", "status": "todo", "priority": "none"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "mat_test-token")

	cmd := newIssueCreateTestCmd()
	_ = cmd.Flags().Set("title", "Card")
	_ = cmd.Flags().Set("from-comment", " "+commentID+" ")
	if err := runIssueCreate(cmd, nil); err != nil {
		t.Fatalf("runIssueCreate: %v", err)
	}
	if body["source_comment_id"] != commentID {
		t.Fatalf("source_comment_id = %#v", body["source_comment_id"])
	}
	if _, ok := body["parent_issue_id"]; ok {
		t.Fatalf("--from-comment must not set a parent: %#v", body)
	}
}

func newIssueSetSourceTestCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "set-source"}
	cmd.Flags().String("from-comment", "", "")
	cmd.Flags().Bool("force", false, "")
	cmd.Flags().String("output", "table", "")
	return cmd
}

func TestRunIssueSetSource(t *testing.T) {
	issueID := uuid.NewString()
	commentID := uuid.NewString()
	var got []map[string]any
	conflict := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/issues/"+issueID+"/source-context" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		got = append(got, body)
		if conflict && body["force"] != true {
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]any{"code": "source_context_already_attached", "error": "source context is already attached"})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id": issueID, "identifier": "MUL-9",
			"source_context": map[string]any{"snapshot": map[string]any{"source_issue": map[string]any{"identifier": "MUL-2"}}},
		})
	}))
	defer srv.Close()
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "mat_test-token")

	// Required flag.
	if err := runIssueSetSource(newIssueSetSourceTestCmd(), []string{issueID}); err == nil || !strings.Contains(err.Error(), "--from-comment") {
		t.Fatalf("missing flag: %v", err)
	}

	cmd := newIssueSetSourceTestCmd()
	_ = cmd.Flags().Set("from-comment", commentID)
	if err := runIssueSetSource(cmd, []string{issueID}); err != nil {
		t.Fatalf("set-source: %v", err)
	}
	if len(got) != 1 || got[0]["comment_id"] != commentID || got[0]["force"] != false {
		t.Fatalf("request = %#v", got)
	}

	// An issue that already has a source: a clear refusal, then --force.
	conflict = true
	cmd = newIssueSetSourceTestCmd()
	_ = cmd.Flags().Set("from-comment", commentID)
	err := runIssueSetSource(cmd, []string{issueID})
	if err == nil || !strings.Contains(err.Error(), "already has a source") || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("conflict: %v", err)
	}
	_ = cmd.Flags().Set("force", "true")
	if err := runIssueSetSource(cmd, []string{issueID}); err != nil {
		t.Fatalf("force: %v", err)
	}
	if last := got[len(got)-1]; last["force"] != true {
		t.Fatalf("force request = %#v", last)
	}
}
