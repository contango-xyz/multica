package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

const askBotUser = "c870104c-345e-4f87-b6c6-707218f9f298"

type askFixture struct {
	issueID string
	runtime string
	agent   string
	task    string
}

func newAskFixture(t *testing.T) askFixture {
	t.Helper()
	f := askFixture{issueID: dbfx.Issue(t, "Ask fixture")}
	dbfx.Cleanup(t, `DELETE FROM issue_ask WHERE issue_id = $1`, f.issueID)
	dbfx.Cleanup(t, `DELETE FROM comment WHERE issue_id = $1`, f.issueID)
	dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE issue_id = $1`, f.issueID)
	f.runtime = dbfx.Runtime(t, "ask seat", testutil.Cols{"provider": "claude", "visibility": "public"})
	f.agent = dbfx.Agent(t, "ask agent", f.runtime, testutil.Cols{"max_concurrent_tasks": 4})
	f.task = dbfx.Task(t, f.agent, testutil.Cols{"issue_id": f.issueID, "runtime_id": f.runtime, "status": "running"})
	return f
}

func (f askFixture) asAgent(req *http.Request) *http.Request {
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", f.agent)
	req.Header.Set("X-Task-ID", f.task)
	return req
}

func askBody(extra map[string]any) map[string]any {
	b := map[string]any{
		"addressee_type": "member", "addressee_id": testUserID, "kind": "decision", "topic": "Which copy?",
		"options": []map[string]string{{"reply": "agree"}, {"reply": "disagree"}},
	}
	for k, v := range extra {
		b[k] = v
	}
	return b
}

type createdAsk struct {
	Ask     IssueAskResponse `json:"ask"`
	Comment CommentResponse  `json:"comment"`
}

func (f askFixture) create(t *testing.T, req *http.Request) createdAsk {
	t.Helper()
	var out createdAsk
	testutil.Call(t, testHandler.CreateIssueAsk, withURLParam(req, "id", f.issueID)).Want(http.StatusCreated).JSON(&out)
	return out
}

func (f askFixture) createReq(extra map[string]any) *http.Request {
	return newRequest("POST", "/api/issues/"+f.issueID+"/asks", askBody(extra))
}

func (f askFixture) comment(t *testing.T, body map[string]any, mutate ...func(*http.Request)) CommentResponse {
	t.Helper()
	req := newRequest("POST", "/api/issues/"+f.issueID+"/comments", body)
	for _, m := range mutate {
		m(req)
	}
	var out CommentResponse
	testutil.Call(t, testHandler.CreateComment, withURLParam(req, "id", f.issueID)).Want(http.StatusCreated).JSON(&out)
	return out
}

func askState(t *testing.T, id string) (state, via string) {
	t.Helper()
	dbfx.QueryRow(t, `SELECT state, coalesce(answered_via, '') FROM issue_ask WHERE id = $1`, id).Scan(&state, &via)
	return state, via
}

func askReq(method, path, askID string, body any, mutate ...func(*http.Request)) *http.Request {
	req := withURLParam(newRequest(method, path, body), "askId", askID)
	for _, m := range mutate {
		m(req)
	}
	return req
}

func TestIssueAskCreateWritesRowAndComment(t *testing.T) {
	f := newAskFixture(t)
	var email string
	dbfx.QueryRow(t, `SELECT email FROM "user" WHERE id = $1`, testUserID).Scan(&email)
	handle, _, _ := strings.Cut(email, "@")
	out := f.create(t, f.createReq(map[string]any{
		"recommended": "agree", "recommend_reason": "it reads better", "default_option": "agree", "reversible": true, "where": "the story",
	}))
	if out.Ask.CommentID != out.Comment.ID || out.Ask.State != "open" || out.Ask.Source != "cli" || out.Ask.AuthorType != "member" || out.Ask.AuthorID != testUserID {
		t.Fatalf("unexpected ask %+v", out.Ask)
	}
	if out.Ask.DefaultOption == nil || *out.Ask.DefaultOption != "agree" || !out.Ask.Reversible || len(out.Ask.Options) != 2 || out.Ask.Options[1].Label != "disagree" {
		t.Fatalf("unexpected options %+v", out.Ask)
	}
	for _, want := range []string{
		"**[NEEDS HUMAN]** Which copy?\n\n",
		"**Where we are:** the story\n\n",
		"**Reply with:** `agree` / `disagree`\n\n",
		"**I recommend:** `agree`: it reads better\n\n",
		"---\n\n",
		"**Default if no answer:** `agree` (reversible)\n\n",
		"[@" + handle + "](mention://member/" + testUserID + ")",
	} {
		if !strings.Contains(out.Comment.Content, want) {
			t.Errorf("comment missing %q:\n%s", want, out.Comment.Content)
		}
	}
}

func TestIssueAskCreateOperatorFormat(t *testing.T) {
	f := newAskFixture(t)
	req := newRequest("POST", "/api/issues/"+f.issueID+"/asks", map[string]any{
		"addressee_type": "role", "addressee_role": "operator", "kind": "operator", "topic": "seat-3 down", "last_line": "exit 1", "diagnosis": "disk", "fix": "resize",
	})
	out := f.create(t, req)
	if out.Ask.AddresseeType != "role" || out.Ask.AddresseeRole == nil || *out.Ask.AddresseeRole != "operator" || out.Ask.AddresseeID != nil {
		t.Fatalf("unexpected ask %+v", out.Ask)
	}
	if !strings.HasPrefix(out.Comment.Content, "**[NEEDS OPERATOR]** seat-3 down\n\n**Last line:** exit 1") || strings.Contains(out.Comment.Content, "mention://") {
		t.Fatalf("unexpected comment %s", out.Comment.Content)
	}
}

func TestIssueAskCreateRefusals(t *testing.T) {
	f := newAskFixture(t)
	cases := map[string]map[string]any{
		"agent addressee":      {"addressee_type": "agent", "addressee_id": f.agent},
		"not a member":         {"addressee_id": "00000000-0000-0000-0000-000000000001"},
		"default irreversible": {"default_option": "agree"},
		"default on merge":     {"kind": "merge", "default_option": "agree", "reversible": true},
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			testutil.Call(t, testHandler.CreateIssueAsk, withURLParam(f.createReq(extra), "id", f.issueID)).Want(http.StatusBadRequest)
		})
	}
	var count int
	dbfx.QueryRow(t, `SELECT count(*) FROM comment WHERE issue_id = $1`, f.issueID).Scan(&count)
	if count != 0 {
		t.Fatalf("a refused ask left %d comments", count)
	}
}

// The ask row is written in the comment's transaction: when it fails, the
// comment does not survive either.
func TestIssueAskCommentRollsBackWithRow(t *testing.T) {
	f := newAskFixture(t)
	body := askBody(map[string]any{"pr_id": "not-a-uuid"})
	req := f.createReq(body)
	// Bypass Normalize's PR check to fail inside CreateAskForComment.
	rec := httptest.NewRecorder()
	in := testAskDraft(t, body)
	ctxReq := req.WithContext(withAskDraftForTest(req.Context(), in))
	testHandler.CreateComment(rec, commentRequestFor(ctxReq, f.issueID, CreateCommentRequest{Content: "**[NEEDS HUMAN]** x"}))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d %s", rec.Code, rec.Body.String())
	}
	var count int
	dbfx.QueryRow(t, `SELECT count(*) FROM comment WHERE issue_id = $1`, f.issueID).Scan(&count)
	if count != 0 {
		t.Fatalf("comment survived a failed ask row: %d", count)
	}
}

func TestIssueAskReplyInThreadAnswers(t *testing.T) {
	f := newAskFixture(t)
	root := f.create(t, f.createReq(nil))
	reply := f.comment(t, map[string]any{"content": "agree", "parent_id": root.Comment.ID}, asMember)
	state, via := askState(t, root.Ask.ID)
	if state != "answered" || via != "comment" {
		t.Fatalf("got %s/%s", state, via)
	}
	var ans string
	dbfx.QueryRow(t, `SELECT answer_comment_id::text FROM issue_ask WHERE id = $1`, root.Ask.ID).Scan(&ans)
	if ans != reply.ID {
		t.Fatalf("answer_comment_id = %s, want %s", ans, reply.ID)
	}
}

// asMember posts as someone other than the ask's author.
func asMember(req *http.Request) {
	req.Header.Set("X-User-ID", askBotUser)
}

func TestIssueAskSiblingReplyAnswers(t *testing.T) {
	// The web reply box posts under the thread root, so a reply to an ask that
	// is itself a reply arrives as its sibling.
	f := newAskFixture(t)
	root := f.comment(t, map[string]any{"content": "the thread"})
	ask := f.create(t, f.createReq(map[string]any{"parent_id": root.ID}))
	f.comment(t, map[string]any{"content": "agree", "parent_id": root.ID}, asMember)
	if state, via := askState(t, ask.Ask.ID); state != "answered" || via != "comment" {
		t.Fatalf("got %s/%s", state, via)
	}
}

func TestIssueAskOtherCommentsLeaveItOpen(t *testing.T) {
	f := newAskFixture(t)
	ask := f.create(t, f.createReq(nil))
	other := f.comment(t, map[string]any{"content": "unrelated thread"})

	f.comment(t, map[string]any{"content": "top-level remark"}, asMember)
	f.comment(t, map[string]any{"content": "reply elsewhere", "parent_id": other.ID}, asMember)
	// The ask's own author replying to it is not an answer.
	f.comment(t, map[string]any{"content": "more detail", "parent_id": ask.Comment.ID})
	// A /note wakes nobody, so it is not an answer.
	f.comment(t, map[string]any{"content": "/note checked", "parent_id": ask.Comment.ID}, asMember)
	// multica-bot is automation.
	t.Setenv(botMemberIDsEnv, askBotUser)
	f.comment(t, map[string]any{"content": "Default applied", "parent_id": ask.Comment.ID}, asMember)
	t.Setenv(botMemberIDsEnv, "")
	// An agent's reply through its task token is not a person's.
	f.comment(t, map[string]any{"content": "agree", "parent_id": ask.Comment.ID}, func(r *http.Request) { f.asAgent(r) })

	if state, _ := askState(t, ask.Ask.ID); state != "open" {
		t.Fatalf("ask should stay open, got %s", state)
	}
}

func TestIssueAskResolvePermissions(t *testing.T) {
	f := newAskFixture(t)
	mine := f.create(t, f.asAgent(f.createReq(nil)))
	if mine.Ask.AuthorType != "agent" || mine.Ask.AuthorID != f.agent || mine.Ask.TaskID == nil || *mine.Ask.TaskID != f.task {
		t.Fatalf("agent ask: %+v", mine.Ask)
	}
	human := f.create(t, f.createReq(nil))

	resolve := func(id string, body map[string]any, want int, mutate ...func(*http.Request)) {
		t.Helper()
		testutil.Call(t, testHandler.ResolveIssueAsk, askReq("POST", "/api/asks/"+id+"/resolve", id, body, mutate...)).Want(want)
	}
	agent := func(r *http.Request) { f.asAgent(r) }

	// Another's ask, and the server-only and operator paths.
	resolve(human.Ask.ID, map[string]any{"answered_via": "default_applied"}, http.StatusForbidden, agent)
	resolve(mine.Ask.ID, map[string]any{"answered_via": "comment"}, http.StatusBadRequest, agent)
	resolve(mine.Ask.ID, map[string]any{"answered_via": "one_tap"}, http.StatusBadRequest, agent)
	resolve(mine.Ask.ID, map[string]any{"answered_via": "ops"}, http.StatusForbidden, agent)
	if state, _ := askState(t, mine.Ask.ID); state != "open" {
		t.Fatalf("refused resolve changed state: %s", state)
	}

	// Its own ask: resolved, attributed to the agent, not a person.
	var out IssueAskResponse
	testutil.Call(t, testHandler.ResolveIssueAsk, askReq("POST", "/api/asks/"+mine.Ask.ID+"/resolve", mine.Ask.ID,
		map[string]any{"answered_via": "pr_approved"}, agent)).Want(http.StatusOK).JSON(&out)
	if out.State != "answered" || out.AnsweredByType == nil || *out.AnsweredByType != "agent" || out.AnsweredBy == nil || *out.AnsweredBy != f.agent {
		t.Fatalf("agent resolve: %+v", out)
	}
	// Closed already: 409.
	resolve(mine.Ask.ID, map[string]any{"answered_via": "status_move"}, http.StatusConflict)

	// A member (and the ops bot, a member) resolves anyone's.
	testutil.Call(t, testHandler.ResolveIssueAsk, askReq("POST", "/api/asks/"+human.Ask.ID+"/resolve", human.Ask.ID,
		map[string]any{"answered_via": "status_move", "answer_text": "moved to Todo"})).Want(http.StatusOK).JSON(&out)
	if out.State != "answered" || *out.AnsweredVia != "status_move" || *out.AnsweredByType != "member" || *out.AnsweredBy != testUserID || *out.AnswerText != "moved to Todo" {
		t.Fatalf("member resolve: %+v", out)
	}
}

func TestIssueAskDefaultAppliedNeedsADefault(t *testing.T) {
	f := newAskFixture(t)
	none := f.create(t, f.createReq(nil))
	testutil.Call(t, testHandler.ResolveIssueAsk, askReq("POST", "/x", none.Ask.ID, map[string]any{"answered_via": "default_applied"})).Want(http.StatusConflict)

	withDefault := f.create(t, f.createReq(map[string]any{"default_option": "agree", "reversible": true}))
	var out IssueAskResponse
	testutil.Call(t, testHandler.ResolveIssueAsk, askReq("POST", "/x", withDefault.Ask.ID, map[string]any{"answered_via": "default_applied"})).Want(http.StatusOK).JSON(&out)
	if *out.AnswerText != "agree" {
		t.Fatalf("default text: %+v", out)
	}
}

func TestIssueAskWithdrawPermissions(t *testing.T) {
	f := newAskFixture(t)
	mine := f.create(t, f.asAgent(f.createReq(nil)))
	human := f.create(t, f.createReq(nil))
	agent := func(r *http.Request) { f.asAgent(r) }
	testutil.Call(t, testHandler.WithdrawIssueAsk, askReq("POST", "/x", human.Ask.ID, map[string]any{"reason": "x"}, agent)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.WithdrawIssueAsk, askReq("POST", "/x", mine.Ask.ID, map[string]any{"reason": "moot"}, agent)).Want(http.StatusOK)
	if state, _ := askState(t, mine.Ask.ID); state != "withdrawn" {
		t.Fatalf("got %s", state)
	}
}

func TestIssueAskClosingCardWithdrawsOpen(t *testing.T) {
	f := newAskFixture(t)
	open := f.create(t, f.createReq(nil))
	answered := f.create(t, f.createReq(nil))
	testutil.Call(t, testHandler.ResolveIssueAsk, askReq("POST", "/x", answered.Ask.ID, map[string]any{"answered_via": "ops"})).Want(http.StatusOK)

	req := withURLParam(newRequest("PATCH", "/api/issues/"+f.issueID, map[string]any{"status": "done"}), "id", f.issueID)
	testutil.Call(t, testHandler.UpdateIssue, req).Want(http.StatusOK)

	if state, _ := askState(t, open.Ask.ID); state != "withdrawn" {
		t.Fatalf("open ask: %s", state)
	}
	if state, via := askState(t, answered.Ask.ID); state != "answered" || via != "ops" {
		t.Fatalf("answered ask changed: %s/%s", state, via)
	}
}

func TestIssueAskDeletedCommentWithdraws(t *testing.T) {
	f := newAskFixture(t)
	ask := f.create(t, f.createReq(nil))
	req := withURLParam(newRequest("DELETE", "/api/comments/"+ask.Comment.ID, nil), "commentId", ask.Comment.ID)
	testutil.Call(t, testHandler.DeleteComment, req).Want(http.StatusNoContent)
	if state, _ := askState(t, ask.Ask.ID); state != "withdrawn" {
		t.Fatalf("got %s", state)
	}
}

func TestIssueAskDeletedWithIssue(t *testing.T) {
	f := newAskFixture(t)
	f.create(t, f.createReq(nil))
	req := withURLParam(newRequest("DELETE", "/api/issues/"+f.issueID, nil), "id", f.issueID)
	testutil.Call(t, testHandler.DeleteIssue, req).Want(http.StatusNoContent)
	var count int
	dbfx.QueryRow(t, `SELECT count(*) FROM issue_ask WHERE issue_id = $1`, f.issueID).Scan(&count)
	if count != 0 {
		t.Fatalf("issue delete left %d asks", count)
	}
}

func TestIssueAskListGetOldestOpen(t *testing.T) {
	f := newAskFixture(t)
	first := f.create(t, f.createReq(map[string]any{"topic": "first"}))
	second := f.create(t, f.createReq(map[string]any{"topic": "second"}))
	testutil.Call(t, testHandler.ResolveIssueAsk, askReq("POST", "/x", first.Ask.ID, map[string]any{"answered_via": "ops"})).Want(http.StatusOK)

	var open []IssueAskResponse
	req := withURLParam(newRequest("GET", "/api/issues/"+f.issueID+"/asks?state=open", nil), "id", f.issueID)
	testutil.Call(t, testHandler.ListIssueAsks, req).Want(http.StatusOK).JSON(&open)
	if len(open) != 1 || open[0].ID != second.Ask.ID {
		t.Fatalf("list: %+v", open)
	}

	var oldest IssueAskResponse
	req = withURLParam(newRequest("GET", "/api/issues/"+f.issueID+"/asks/oldest-open", nil), "id", f.issueID)
	testutil.Call(t, testHandler.GetOldestOpenIssueAsk, req).Want(http.StatusOK).JSON(&oldest)
	if oldest.ID != second.Ask.ID {
		t.Fatalf("oldest: %+v", oldest)
	}

	var got IssueAskResponse
	testutil.Call(t, testHandler.GetIssueAsk, askReq("GET", "/x", first.Ask.ID, nil)).Want(http.StatusOK).JSON(&got)
	if got.ID != first.Ask.ID || got.State != "answered" {
		t.Fatalf("get: %+v", got)
	}
}

func TestIssueAskOffSwitch(t *testing.T) {
	f := newAskFixture(t)
	ask := f.create(t, f.createReq(nil))
	t.Setenv("MULTICA_ASKS", "0")
	testutil.Call(t, testHandler.CreateIssueAsk, withURLParam(f.createReq(nil), "id", f.issueID)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.GetIssueAsk, askReq("GET", "/x", ask.Ask.ID, nil)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.ResolveIssueAsk, askReq("POST", "/x", ask.Ask.ID, map[string]any{"answered_via": "ops"})).Want(http.StatusForbidden)
	// A reply carries on as a plain comment and the row is left alone.
	f.comment(t, map[string]any{"content": "agree", "parent_id": ask.Comment.ID}, asMember)
	if state, _ := askState(t, ask.Ask.ID); state != "open" {
		t.Fatalf("got %s", state)
	}
}
