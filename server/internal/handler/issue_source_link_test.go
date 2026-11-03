package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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

// A long QA thread (contango issue-origin-2): over the general limit, the CLI
// paths keep the anchor and fit the rest instead of refusing.
func TestIssueSourceFromLongThreadIsFittedNotRefused(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	source := fixtureIssue(t, "Android QA "+uuid.NewString()[:6])
	long := func(n int, tag string) string { return tag + " " + strings.Repeat("verdict line. ", n/14) }
	root := dbfx.Comment(t, source, long(300<<10, "root"))
	var oldest string
	for i := 0; i < 4; i++ {
		id := dbfx.Comment(t, source, long(300<<10, fmt.Sprintf("reply-%d", i)), testutil.Cols{"parent_id": root})
		if i == 0 {
			oldest = id
		}
	}
	anchor := dbfx.Comment(t, source, long(40<<10, "anchor verdict"), testutil.Cols{"parent_id": root})
	// Order the thread by time: root, replies, then the anchor.
	dbfx.Exec(t, `UPDATE comment SET created_at = now() - interval '1 hour' WHERE id = $1`, root)
	dbfx.Exec(t, `UPDATE comment SET created_at = now() + interval '1 minute' WHERE id = $1`, anchor)

	target := fixtureIssue(t, "Fix from QA")
	cleanupIssueWithSource(t, target)
	w := httptest.NewRecorder()
	testHandler.SetIssueSourceContext(w, withURLParam(newRequest("POST", "/api/issues/"+target+"/source-context",
		map[string]any{"comment_id": anchor}), "id", target))
	if w.Code != http.StatusOK {
		t.Fatalf("set-source on a long thread: %d %s", w.Code, w.Body.String())
	}
	var resp IssueResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	sc := resp.SourceContext
	if sc == nil || sc.Snapshot.Truncated == nil || len(sc.Snapshot.Truncated.OmittedCommentIDs) == 0 || sc.Snapshot.Truncated.OmittedCommentIDs[0] != oldest {
		t.Fatalf("expected a fitted snapshot dropping the oldest reply first: %+v", sc)
	}
	threadIDs := map[string]bool{}
	for _, c := range sc.Snapshot.CommentThread {
		threadIDs[c.ID] = true
	}
	if !threadIDs[anchor] || !threadIDs[root] || sc.Snapshot.CommentThread[len(sc.Snapshot.CommentThread)-1].ID != anchor {
		t.Fatalf("anchor and root must be kept: %v", threadIDs)
	}
	// What was left out on purpose does not read as a change.
	if sc.DisplayState != "unchanged" || sc.CommentThreadState != "unchanged" || len(sc.ChangeReasons) != 0 {
		t.Fatalf("display=%s thread=%s reasons=%v", sc.DisplayState, sc.CommentThreadState, sc.ChangeReasons)
	}
	var stored []byte
	if err := testPool.QueryRow(ctx, `SELECT snapshot FROM issue_source_context WHERE issue_id = $1`, target).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) > 1<<20 || !strings.Contains(string(stored), `"truncated"`) {
		t.Fatalf("stored snapshot is %d bytes, truncated marker present: %v", len(stored), strings.Contains(string(stored), `"truncated"`))
	}

	// Create --from-comment takes the same path.
	wc, created := createIssueWithBody(t, map[string]any{"title": "Also from QA", "source_comment_id": anchor}, nil)
	if wc.Code != http.StatusCreated || created.SourceContext == nil || created.SourceContext.Snapshot.Truncated == nil {
		t.Fatalf("create from a long thread: %d %s", wc.Code, wc.Body.String())
	}

	// Refused only when the anchor alone is over the limit.
	huge := dbfx.Comment(t, source, long((1<<20)+(64<<10), "too long"), testutil.Cols{"parent_id": root})
	other := fixtureIssue(t, "Too big")
	w = httptest.NewRecorder()
	testHandler.SetIssueSourceContext(w, withURLParam(newRequest("POST", "/api/issues/"+other+"/source-context",
		map[string]any{"comment_id": huge}), "id", other))
	if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "source_context_too_large") {
		t.Fatalf("oversized anchor: %d %s", w.Code, w.Body.String())
	}
}

// A thread with a system comment (and a plugin one) must not fail the capture
// over author names (contango issue-origin-3: live 500 on CTG-892, CTG-501).
func TestIssueSourceFromThreadWithSystemComment(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	const zeroUUID = "00000000-0000-0000-0000-000000000000"
	source := fixtureIssue(t, "Thread with a system note "+uuid.NewString()[:6])
	root := dbfx.Comment(t, source, "QA verdict: Android fails on login")
	system := dbfx.Comment(t, source, "Runtime went offline; the run was requeued.",
		testutil.Cols{"parent_id": root, "author_type": "system", "author_id": zeroUUID})
	plugin := dbfx.Comment(t, source, "Plugin note", testutil.Cols{"parent_id": root, "author_type": "plugin", "author_id": uuid.NewString()})
	anchor := dbfx.Comment(t, source, "Please file the fix", testutil.Cols{"parent_id": root})
	dbfx.Exec(t, `UPDATE comment SET created_at = now() - interval '1 hour' WHERE id = $1`, root)
	dbfx.Exec(t, `UPDATE comment SET created_at = now() - interval '30 minutes' WHERE id = $1`, system)
	dbfx.Exec(t, `UPDATE comment SET created_at = now() - interval '20 minutes' WHERE id = $1`, plugin)

	target := fixtureIssue(t, "Fix from a thread with a system note")
	cleanupIssueWithSource(t, target)
	w := httptest.NewRecorder()
	testHandler.SetIssueSourceContext(w, withURLParam(newRequest("POST", "/api/issues/"+target+"/source-context",
		map[string]any{"comment_id": anchor}), "id", target))
	if w.Code != http.StatusOK {
		t.Fatalf("set-source: %d %s", w.Code, w.Body.String())
	}
	var resp IssueResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.SourceContext == nil {
		t.Fatalf("no source_context: %s", w.Body.String())
	}
	names := map[string]string{}
	for _, c := range resp.SourceContext.Snapshot.CommentThread {
		names[c.ID] = c.Author.Name
	}
	if names[system] != "Multica" || names[plugin] != "System" || names[anchor] == "" {
		t.Fatalf("author names = %v", names)
	}
	for _, state := range resp.SourceContext.SourceAuthorState {
		if state.Type == "system" && state.State != "unchanged" {
			t.Fatalf("system author state = %+v", state)
		}
	}

	// Create --from-comment takes the same path.
	wc, created := createIssueWithBody(t, map[string]any{"title": "Also from that thread", "source_comment_id": anchor}, nil)
	if wc.Code != http.StatusCreated || created.SourceContext == nil {
		t.Fatalf("create: %d %s", wc.Code, wc.Body.String())
	}
}
