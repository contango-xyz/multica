package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// sourceLinkFixture: a source issue with a comment, and helpers to read what
// got stored. Everything lives in the handler test workspace.
type sourceLinkFixture struct {
	sourceIssue string
	commentID   string
}

// fixtureIssue inserts an issue numbered far above the workspace counter:
// dbfx.Issue takes the next free number without bumping the counter, so an
// API create in the same test would collide on it.
func fixtureIssue(t *testing.T, title string) string {
	t.Helper()
	return dbfx.Issue(t, title, testutil.Cols{
		"workspace_id": testWorkspaceID,
		"number":       8_000_000 + int(uuid.New().ID()%1_000_000),
	})
}

func newSourceLinkFixture(t *testing.T) sourceLinkFixture {
	t.Helper()
	source := fixtureIssue(t, "Source of the ask "+uuid.NewString()[:6])
	comment := dbfx.Comment(t, source, "Please file a card for the login fix")
	return sourceLinkFixture{sourceIssue: source, commentID: comment}
}

func cleanupIssueWithSource(t *testing.T, issueID string) {
	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM issue_source_context WHERE issue_id = $1`, issueID)
		testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
	})
}

type storedSource struct {
	sourceIssueID, anchorCommentID, state, originTaskID string
	count                                               int
}

func loadStoredSource(t *testing.T, issueID string) storedSource {
	t.Helper()
	var s storedSource
	_ = testPool.QueryRow(context.Background(), `
		SELECT count(*) OVER (), source_issue_id::text, anchor_comment_id::text, state, COALESCE(origin_task_id::text, '')
		FROM issue_source_context WHERE issue_id = $1`, issueID,
	).Scan(&s.count, &s.sourceIssueID, &s.anchorCommentID, &s.state, &s.originTaskID)
	return s
}

func createIssueWithBody(t *testing.T, body map[string]any, mutate func(*http.Request)) (*httptest.ResponseRecorder, IssueResponse) {
	t.Helper()
	w := httptest.NewRecorder()
	r := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, body)
	if mutate != nil {
		mutate(r)
	}
	testHandler.CreateIssue(w, r)
	var created IssueResponse
	if w.Code == http.StatusCreated {
		_ = json.Unmarshal(w.Body.Bytes(), &created)
		cleanupIssueWithSource(t, created.ID)
	}
	return w, created
}

func TestCreateIssueFromCommentRecordsSourceWithoutParent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newSourceLinkFixture(t)
	otherParent := fixtureIssue(t, "Unrelated parent")

	// Source on a non-parent issue, with an independent --parent.
	w, created := createIssueWithBody(t, map[string]any{
		"title":             "Fix the login",
		"parent_issue_id":   otherParent,
		"source_comment_id": f.commentID,
	}, nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	if created.ParentIssueID == nil || *created.ParentIssueID != otherParent {
		t.Fatalf("parent = %v, want the explicit --parent %s", created.ParentIssueID, otherParent)
	}
	if created.SourceContext == nil || created.SourceContext.Snapshot.SourceIssue.ID != f.sourceIssue {
		t.Fatalf("response source_context = %+v", created.SourceContext)
	}
	got := loadStoredSource(t, created.ID)
	if got.count != 1 || got.sourceIssueID != f.sourceIssue || got.anchorCommentID != f.commentID || got.state != "attached" || got.originTaskID != "" {
		t.Fatalf("stored source = %+v", got)
	}

	// No parent at all: still not a sub-issue of the source.
	w, created = createIssueWithBody(t, map[string]any{"title": "Fix the logout", "source_comment_id": f.commentID}, nil)
	if w.Code != http.StatusCreated || created.ParentIssueID != nil {
		t.Fatalf("create without parent: %d parent=%v %s", w.Code, created.ParentIssueID, w.Body.String())
	}
	if got := loadStoredSource(t, created.ID); got.sourceIssueID != f.sourceIssue {
		t.Fatalf("stored source = %+v", got)
	}
}

func TestCreateIssueFromCommentByAgentStampsOriginTask(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	f := newSourceLinkFixture(t)
	agentID := createHandlerTestAgent(t, "issue-origin-agent-"+uuid.NewString()[:6], nil)
	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, status, priority, originator_user_id, accountable_user_id)
		VALUES ($1, (SELECT runtime_id FROM agent WHERE id = $1), 'running', 0, $2, $2)
		RETURNING id`, agentID, testUserID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, taskID) })

	w, created := createIssueWithBody(t, map[string]any{"title": "Agent-filed card", "source_comment_id": f.commentID}, func(r *http.Request) {
		r.Header.Set("X-Agent-ID", agentID)
		r.Header.Set("X-Task-ID", taskID)
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	if got := loadStoredSource(t, created.ID); got.originTaskID != taskID || got.sourceIssueID != f.sourceIssue {
		t.Fatalf("stored source = %+v, want origin task %s", got, taskID)
	}
}

func TestCreateIssueFromCommentRefusals(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	// A comment from another workspace is not found here.
	otherWS := dbfx.Workspace(t, "Other", "origin-other-"+uuid.NewString()[:8])
	otherIssue := dbfx.Issue(t, "Elsewhere", testutil.Cols{"workspace_id": otherWS})
	foreign := dbfx.Comment(t, otherIssue, "not yours", testutil.Cols{"workspace_id": otherWS})
	before := dbfx.Count(t, `SELECT count(*) FROM issue WHERE workspace_id = $1`, testWorkspaceID)

	w, _ := createIssueWithBody(t, map[string]any{"title": "Nope", "source_comment_id": foreign}, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign comment: %d %s", w.Code, w.Body.String())
	}
	w, _ = createIssueWithBody(t, map[string]any{"title": "Nope", "source_comment_id": "not-a-uuid"}, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad uuid: %d %s", w.Code, w.Body.String())
	}
	if after := dbfx.Count(t, `SELECT count(*) FROM issue WHERE workspace_id = $1`, testWorkspaceID); after != before {
		t.Fatalf("a refused create still created an issue (%d -> %d)", before, after)
	}
}

func TestSetIssueSourceContext(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newSourceLinkFixture(t)
	second := newSourceLinkFixture(t)
	target := fixtureIssue(t, "Filed without a source")
	cleanupIssueWithSource(t, target)

	set := func(issue, comment string, force bool) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := withURLParam(newRequest("POST", "/api/issues/"+issue+"/source-context",
			map[string]any{"comment_id": comment, "force": force}), "id", issue)
		testHandler.SetIssueSourceContext(w, r)
		return w
	}

	w := set(target, f.commentID, false)
	if w.Code != http.StatusOK {
		t.Fatalf("set-source: %d %s", w.Code, w.Body.String())
	}
	var resp IssueResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.SourceContext == nil || resp.SourceContext.Snapshot.SourceIssue.ID != f.sourceIssue || resp.ParentIssueID != nil {
		t.Fatalf("response = source %+v parent %v", resp.SourceContext, resp.ParentIssueID)
	}
	if got := loadStoredSource(t, target); got.count != 1 || got.anchorCommentID != f.commentID {
		t.Fatalf("stored = %+v", got)
	}

	// A second source is refused...
	w = set(target, second.commentID, false)
	if w.Code != http.StatusConflict || !json.Valid(w.Body.Bytes()) {
		t.Fatalf("second source: %d %s", w.Code, w.Body.String())
	}
	var errBody struct{ Code string }
	_ = json.Unmarshal(w.Body.Bytes(), &errBody)
	if errBody.Code != "source_context_already_attached" {
		t.Fatalf("code = %q", errBody.Code)
	}
	if got := loadStoredSource(t, target); got.anchorCommentID != f.commentID {
		t.Fatalf("refusal changed the source: %+v", got)
	}

	// ...unless forced, which replaces it.
	w = set(target, second.commentID, true)
	if w.Code != http.StatusOK {
		t.Fatalf("force: %d %s", w.Code, w.Body.String())
	}
	if got := loadStoredSource(t, target); got.count != 1 || got.anchorCommentID != second.commentID || got.sourceIssueID != second.sourceIssue {
		t.Fatalf("after force = %+v", got)
	}

	// Unknown issue and foreign comment.
	if w = set(uuid.NewString(), f.commentID, false); w.Code != http.StatusNotFound {
		t.Fatalf("unknown issue: %d %s", w.Code, w.Body.String())
	}
	otherWS := dbfx.Workspace(t, "Other", "origin-other-"+uuid.NewString()[:8])
	otherIssue := dbfx.Issue(t, "Elsewhere", testutil.Cols{"workspace_id": otherWS})
	foreign := dbfx.Comment(t, otherIssue, "not yours", testutil.Cols{"workspace_id": otherWS})
	fresh := fixtureIssue(t, "Still sourceless")
	if w = set(fresh, foreign, false); w.Code != http.StatusNotFound {
		t.Fatalf("foreign comment: %d %s", w.Code, w.Body.String())
	}
	if got := loadStoredSource(t, fresh); got.count != 0 {
		t.Fatalf("foreign comment stored a source: %+v", got)
	}
}
