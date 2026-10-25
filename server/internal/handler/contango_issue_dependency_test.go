package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type dependencyListResponse struct {
	BlockedBy     []IssueDependencyRef `json:"blocked_by"`
	Blocks        []IssueDependencyRef `json:"blocks"`
	IssueRevision int64                `json:"issue_revision"`
}

func addDependencyForTest(t *testing.T, issueID, blockedBy string, wantStatus int) dependencyListResponse {
	t.Helper()
	w := httptest.NewRecorder()
	r := withURLParam(newRequest(http.MethodPost, "/api/issues/"+issueID+"/dependencies", map[string]any{"blocked_by": blockedBy}), "id", issueID)
	testHandler.AddIssueDependency(w, r)
	if w.Code != wantStatus {
		t.Fatalf("AddIssueDependency %s blocked by %s: expected %d, got %d: %s", issueID, blockedBy, wantStatus, w.Code, w.Body.String())
	}
	var out dependencyListResponse
	if wantStatus == http.StatusOK {
		if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
			t.Fatalf("decode AddIssueDependency: %v", err)
		}
	}
	return out
}

func getIssueForDependencyTest(t *testing.T, id string) IssueResponse {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.GetIssue(w, withURLParam(newRequest(http.MethodGet, "/api/issues/"+id, nil), "id", id))
	if w.Code != http.StatusOK {
		t.Fatalf("GetIssue: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var out IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
		t.Fatalf("decode GetIssue: %v", err)
	}
	return out
}

func refIDs(refs []IssueDependencyRef) []string {
	ids := make([]string, len(refs))
	for i, r := range refs {
		ids[i] = r.ID
	}
	return ids
}

func TestIssueDependencyAddListRemove(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	app := createIssueForTest(t, map[string]any{"title": "dependent app change"})
	core := createIssueForTest(t, map[string]any{"title": "critical blocker"})

	// By identifier, as the CLI and agents give it.
	added := addDependencyForTest(t, app.ID, core.Identifier, http.StatusOK)
	if got := refIDs(added.BlockedBy); len(got) != 1 || got[0] != core.ID {
		t.Fatalf("blocked_by after add = %v, want [%s]", got, core.ID)
	}
	if added.BlockedBy[0].Identifier != core.Identifier || added.BlockedBy[0].Status == "" {
		t.Fatalf("blocked_by ref = %+v, want identifier %s and a status", added.BlockedBy[0], core.Identifier)
	}
	if added.IssueRevision <= int64(app.Revision) {
		t.Fatalf("issue_revision %d did not advance past %d", added.IssueRevision, app.Revision)
	}

	// Idempotent: a second add changes nothing.
	again := addDependencyForTest(t, app.ID, core.ID, http.StatusOK)
	if len(again.BlockedBy) != 1 {
		t.Fatalf("duplicate add produced %d edges", len(again.BlockedBy))
	}

	// Both sides show on the issue detail.
	appDetail := getIssueForDependencyTest(t, app.ID)
	if appDetail.BlockedBy == nil || len(*appDetail.BlockedBy) != 1 || appDetail.Blocks == nil || len(*appDetail.Blocks) != 0 {
		t.Fatalf("app detail blocked_by=%v blocks=%v, want one blocker and an empty list", appDetail.BlockedBy, appDetail.Blocks)
	}
	coreDetail := getIssueForDependencyTest(t, core.ID)
	if coreDetail.Blocks == nil || len(*coreDetail.Blocks) != 1 || (*coreDetail.Blocks)[0].ID != app.ID {
		t.Fatalf("core detail blocks = %v, want [%s]", coreDetail.Blocks, app.ID)
	}

	// The change is in the issue's activity.
	var activities int
	if err := testPool.QueryRow(t.Context(), `SELECT count(*) FROM activity_log WHERE issue_id = $1 AND action = 'dependency_added'`, app.ID).Scan(&activities); err != nil {
		t.Fatalf("count activity: %v", err)
	}
	if activities != 1 {
		t.Fatalf("dependency_added activity rows = %d, want 1 (the duplicate add must not log)", activities)
	}

	// Remove.
	w := httptest.NewRecorder()
	r := withURLParams(newRequest(http.MethodDelete, "/api/issues/"+app.ID+"/dependencies/"+core.Identifier, nil), "id", app.ID, "blockerId", core.Identifier)
	testHandler.RemoveIssueDependency(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("RemoveIssueDependency: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var removed dependencyListResponse
	if err := json.NewDecoder(w.Body).Decode(&removed); err != nil {
		t.Fatalf("decode RemoveIssueDependency: %v", err)
	}
	if len(removed.BlockedBy) != 0 {
		t.Fatalf("blocked_by after remove = %v, want empty", removed.BlockedBy)
	}
}

func TestIssueDependencyRefusesSelfAndCycles(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	a := createIssueForTest(t, map[string]any{"title": "cycle a"})
	b := createIssueForTest(t, map[string]any{"title": "cycle b"})
	c := createIssueForTest(t, map[string]any{"title": "cycle c"})

	addDependencyForTest(t, a.ID, a.ID, http.StatusBadRequest)

	addDependencyForTest(t, a.ID, b.ID, http.StatusOK) // a waits on b
	addDependencyForTest(t, b.ID, c.ID, http.StatusOK) // b waits on c
	addDependencyForTest(t, c.ID, a.ID, http.StatusConflict)
	addDependencyForTest(t, b.ID, a.ID, http.StatusConflict)

	addDependencyForTest(t, a.ID, "not-an-issue", http.StatusNotFound)
}

func TestIssueDependencyDeletedIssueLeavesNoEdge(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	app := createIssueForTest(t, map[string]any{"title": "outlives its blocker"})
	blocker := createIssueForTest(t, map[string]any{"title": "deleted blocker"})
	addDependencyForTest(t, app.ID, blocker.ID, http.StatusOK)

	w := httptest.NewRecorder()
	testHandler.DeleteIssue(w, withURLParam(newRequest(http.MethodDelete, "/api/issues/"+blocker.ID, nil), "id", blocker.ID))
	if w.Code >= 300 {
		t.Fatalf("DeleteIssue: got %d: %s", w.Code, w.Body.String())
	}
	if detail := getIssueForDependencyTest(t, app.ID); detail.BlockedBy == nil || len(*detail.BlockedBy) != 0 {
		t.Fatalf("blocked_by after deleting the blocker = %v, want empty", detail.BlockedBy)
	}
}

func TestIssueDependencyShownInIssueList(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	app := createIssueForTest(t, map[string]any{"title": "listed dependent"})
	core := createIssueForTest(t, map[string]any{"title": "listed blocker"})
	addDependencyForTest(t, app.ID, core.ID, http.StatusOK)

	w := httptest.NewRecorder()
	testHandler.ListIssues(w, newRequest(http.MethodGet, "/api/issues?workspace_id="+testWorkspaceID+"&limit=200", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("ListIssues: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var out struct {
		Issues []IssueResponse `json:"issues"`
	}
	if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
		t.Fatalf("decode ListIssues: %v", err)
	}
	found := map[string]IssueResponse{}
	for _, i := range out.Issues {
		found[i.ID] = i
	}
	a, ok := found[app.ID]
	if !ok || a.BlockedBy == nil || len(*a.BlockedBy) != 1 || (*a.BlockedBy)[0].ID != core.ID {
		t.Fatalf("listed dependent blocked_by = %v (found=%v), want [%s]", a.BlockedBy, ok, core.ID)
	}
	if c := found[core.ID]; c.Blocks == nil || len(*c.Blocks) != 1 {
		t.Fatalf("listed blocker blocks = %v, want one", c.Blocks)
	}
}
