package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

const testBlockerUUID = "22222222-2222-2222-2222-222222222222"

func newIssueDependencyTestCmd(blockedBy string) *cobra.Command {
	c := &cobra.Command{Use: "dep"}
	c.Flags().String("output", "json", "")
	c.Flags().String("blocked-by", "", "")
	if blockedBy != "" {
		_ = c.Flags().Set("blocked-by", blockedBy)
	}
	return c
}

// dependencyTestServer answers resolveIssueRef for two issues and records every
// dependency request with its body.
func dependencyTestServer(t *testing.T) *[]string {
	t.Helper()
	var calls []string
	issue := func(id, identifier string) map[string]any {
		return map[string]any{"id": id, "identifier": identifier, "title": identifier}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/issues/"+testIssueUUID:
			_ = json.NewEncoder(w).Encode(issue(testIssueUUID, "MUL-1"))
		case r.Method == http.MethodGet && r.URL.Path == "/api/issues/"+testBlockerUUID:
			_ = json.NewEncoder(w).Encode(issue(testBlockerUUID, "MUL-2"))
		case strings.HasPrefix(r.URL.Path, "/api/issues/"+testIssueUUID+"/dependencies"):
			calls = append(calls, strings.TrimSpace(r.Method+" "+r.URL.Path+" "+string(body)))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"blocked_by": []any{map[string]any{"id": testBlockerUUID, "identifier": "MUL-2", "status": "in_progress", "title": "blocker"}},
				"blocks":     []any{},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")
	return &calls
}

func TestIssueDependencyAddPostsBlockerID(t *testing.T) {
	calls := dependencyTestServer(t)
	out, err := captureStdout(t, func() error {
		return runIssueDependencyAdd(newIssueDependencyTestCmd(testBlockerUUID), []string{testIssueUUID})
	})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	want := `POST /api/issues/` + testIssueUUID + `/dependencies {"blocked_by":"` + testBlockerUUID + `"}`
	if len(*calls) != 1 || (*calls)[0] != want {
		t.Fatalf("calls = %v, want [%s]", *calls, want)
	}
	if !strings.Contains(out, `"identifier": "MUL-2"`) || !strings.Contains(out, `"blocks"`) {
		t.Fatalf("json output = %s, want blocked_by and blocks", out)
	}
}

func TestIssueDependencyRemoveDeletesThenLists(t *testing.T) {
	calls := dependencyTestServer(t)
	if _, err := captureStdout(t, func() error {
		return runIssueDependencyRemove(newIssueDependencyTestCmd(testBlockerUUID), []string{testIssueUUID})
	}); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if len(*calls) != 2 || !strings.HasPrefix((*calls)[0], "DELETE /api/issues/"+testIssueUUID+"/dependencies/"+testBlockerUUID) ||
		!strings.HasPrefix((*calls)[1], "GET /api/issues/"+testIssueUUID+"/dependencies") {
		t.Fatalf("calls = %v, want DELETE then GET", *calls)
	}
}

func TestIssueDependencyTableOutput(t *testing.T) {
	dependencyTestServer(t)
	cmd := newIssueDependencyTestCmd("")
	_ = cmd.Flags().Set("output", "table")
	out, err := captureStdout(t, func() error { return runIssueDependencyList(cmd, []string{testIssueUUID}) })
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !strings.Contains(out, "blocked by") || !strings.Contains(out, "MUL-2") || !strings.Contains(out, "in_progress") {
		t.Fatalf("table output = %q, want the blocker row", out)
	}
}

func TestIssueDependencyCommandsRequireBlockedBy(t *testing.T) {
	for _, c := range []*cobra.Command{issueDependencyAddCmd, issueDependencyRemoveCmd} {
		f := c.Flags().Lookup("blocked-by")
		if f == nil || f.Annotations[cobra.BashCompOneRequiredFlag] == nil {
			t.Fatalf("%s: --blocked-by must be a required flag", c.Name())
		}
	}
}
