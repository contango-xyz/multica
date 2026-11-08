package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// replyFixture: a signal fixture plus an issue in its workspace with the
// agent's ask on it and the mention that carried the ask.
type replyFixture struct {
	signalFixture
	issueID   string
	askID     string
	mentionID string
}

func newReplyFixture(t *testing.T) replyFixture {
	t.Helper()
	f := replyFixture{signalFixture: newSignalFixture(t)}
	f.issueID = dbfx.Issue(t, "Pick the copy", testutil.Cols{"workspace_id": f.workspaceID})
	f.askID = dbfx.Comment(t, f.issueID, "**[NEEDS HUMAN]** Which copy?\n\n**Reply with:** `agree` / `disagree`",
		testutil.Cols{"workspace_id": f.workspaceID, "author_id": f.botUserID})
	dbfx.Cleanup(t, `DELETE FROM comment WHERE issue_id = $1`, f.issueID)
	f.mentionID = dbfx.Insert(t, "inbox_item", testutil.Cols{
		"workspace_id": f.workspaceID, "recipient_type": "member", "recipient_id": f.recipientID,
		"type": "mentioned", "severity": "action_required", "issue_id": f.issueID, "title": "Pick the copy",
	})
	return f
}

func (f replyFixture) replies() []map[string]any {
	return []map[string]any{
		{"label": "Approve: agree", "content": "agree", "parent_comment_id": f.askID},
		{"label": "Reply: disagree", "content": "disagree", "parent_comment_id": f.askID},
	}
}

// raise upserts a decision signal with replies on the fixture's issue and
// returns its inbox item id.
func (f replyFixture) raise(t *testing.T, over map[string]any) string {
	t.Helper()
	b := map[string]any{"group": "decision", "issue_id": f.issueID, "replies": f.replies()}
	for k, v := range over {
		b[k] = v
	}
	var out signalUpsertResponse
	testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
		signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(b))).
		Want(http.StatusCreated).JSON(&out)
	return out.Item.ID
}

func replyRequest(itemID, userID, workspaceID string, body any) *http.Request {
	return withURLParam(signalRequest("/api/inbox/"+itemID+"/signal-reply", userID, workspaceID, body), "id", itemID)
}

func replyHandler() http.HandlerFunc {
	return RequireHumanActor(http.HandlerFunc(testHandler.ReplyToInboxSignal)).ServeHTTP
}

func TestInboxSignalRepliesValidation(t *testing.T) {
	f := newReplyFixture(t)
	otherIssue := dbfx.Issue(t, "Elsewhere", testutil.Cols{"workspace_id": f.workspaceID})
	foreignComment := dbfx.Comment(t, otherIssue, "elsewhere", testutil.Cols{"workspace_id": f.workspaceID})
	dbfx.Cleanup(t, `DELETE FROM comment WHERE issue_id = $1`, otherIssue)
	reply := func(over map[string]any) map[string]any {
		r := map[string]any{"label": "Approve: agree", "content": "agree", "parent_comment_id": f.askID}
		for k, v := range over {
			r[k] = v
		}
		return r
	}
	cases := map[string]map[string]any{
		"three replies":        {"replies": []any{reply(nil), reply(nil), reply(nil)}},
		"empty label":          {"replies": []any{reply(map[string]any{"label": " "})}},
		"long label":           {"replies": []any{reply(map[string]any{"label": strings.Repeat("x", 41)})}},
		"empty content":        {"replies": []any{reply(map[string]any{"content": ""})}},
		"long content":         {"replies": []any{reply(map[string]any{"content": strings.Repeat("x", 501)})}},
		"bad parent":           {"replies": []any{reply(map[string]any{"parent_comment_id": "nope"})}},
		"parent on other card": {"replies": []any{reply(map[string]any{"parent_comment_id": foreignComment})}},
		"unknown parent":       {"replies": []any{reply(map[string]any{"parent_comment_id": uuid.NewString()})}},
		"no issue":             {"issue_id": nil, "replies": []any{reply(nil)}},
	}
	for name, over := range cases {
		t.Run(name, func(t *testing.T) {
			b := map[string]any{"group": "decision", "issue_id": f.issueID}
			for k, v := range over {
				b[k] = v
			}
			testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
				signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(b))).
				Want(http.StatusBadRequest)
		})
	}

	// Valid: stored on the details; a signal without replies stores none.
	id := f.raise(t, map[string]any{"replies": []any{reply(map[string]any{"content": "  agree  "}), reply(map[string]any{"parent_comment_id": ""})}})
	var raw []byte
	if err := testPool.QueryRow(t.Context(), `SELECT details FROM inbox_item WHERE id = $1`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var d signalDetails
	_ = json.Unmarshal(raw, &d)
	if len(d.Replies) != 2 || d.Replies[0].Content != "agree" || d.Replies[0].ParentCommentID != f.askID || d.Replies[1].ParentCommentID != "" {
		t.Fatalf("stored replies = %+v", d.Replies)
	}
	plainID := f.raise(t, map[string]any{"key": "no-replies", "replies": nil})
	if dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE id = $1 AND details ? 'replies'`, plainID) != 0 {
		t.Fatal("a signal without replies stored a replies key")
	}
}

func TestInboxSignalReplyPostsAsRecipient(t *testing.T) {
	f := newReplyFixture(t)
	itemID := f.raise(t, nil)
	rec := recordInboxEvents(t, f.recipientID)

	var out struct {
		Comment CommentResponse   `json:"comment"`
		Item    InboxItemResponse `json:"item"`
	}
	testutil.Call(t, replyHandler(), replyRequest(itemID, f.recipientID, f.workspaceID,
		map[string]any{"index": 0, "content": "agree"})).Want(http.StatusCreated).JSON(&out)

	if out.Comment.Content != "agree" || out.Comment.AuthorType != "member" || out.Comment.AuthorID != f.recipientID ||
		out.Comment.ParentID == nil || *out.Comment.ParentID != f.askID {
		t.Fatalf("comment = %+v", out.Comment)
	}
	if dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id = $1 AND author_id = $2 AND parent_id = $3 AND content = 'agree'`,
		f.issueID, f.recipientID, f.askID) != 1 {
		t.Fatal("reply comment not stored as the recipient's reply to the ask")
	}
	// Archived for the reader with the mention that carried the ask; not
	// resolved, so the feeder's next pass keeps it quiet instead of re-creating it.
	if !out.Item.Archived {
		t.Fatal("signal not archived in the response")
	}
	if dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE id = $1 AND archived AND details->>'resolved_at' IS NULL`, itemID) != 1 {
		t.Fatal("signal should be archived, not resolved")
	}
	if dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE id = $1 AND archived`, f.mentionID) != 1 {
		t.Fatal("the ask's mention was not archived")
	}
	if rec.get("inbox:archived") != 1 {
		t.Fatalf("inbox:archived events = %d", rec.get("inbox:archived"))
	}
	// A feeder update of the same key stays archived (no re-create, no push).
	var up signalUpsertResponse
	testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
		signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID,
			f.body(map[string]any{"group": "decision", "issue_id": f.issueID, "replies": f.replies(), "summary": "CTG-1 · waiting 7 h", "push": false}))).
		Want(http.StatusOK).JSON(&up)
	if up.Created || up.Pushed || !up.Item.Archived {
		t.Fatalf("feeder update after a reply: created=%v pushed=%v archived=%v", up.Created, up.Pushed, up.Item.Archived)
	}
}

func TestInboxSignalReplyRefusals(t *testing.T) {
	f := newReplyFixture(t)
	itemID := f.raise(t, nil)
	other := dbfx.User(t, "Other", "other-"+uuid.NewString()[:8]+"@example.com")
	dbfx.Member(t, f.workspaceID, other, "admin")
	call := func(itemID, userID string, body any, want int, header ...string) {
		t.Helper()
		req := replyRequest(itemID, userID, f.workspaceID, body)
		if len(header) == 2 {
			req.Header.Set(header[0], header[1])
		}
		testutil.Call(t, replyHandler(), req).Want(want)
	}
	ok := map[string]any{"index": 0, "content": "agree"}

	// Someone else's signal, even a workspace admin's click (or the feeder's bot).
	call(itemID, other, ok, http.StatusNotFound)
	call(itemID, f.botUserID, ok, http.StatusNotFound)
	// Agent credentials never click.
	call(itemID, f.recipientID, ok, http.StatusForbidden, "X-Actor-Source", "task_token")
	// What the client confirmed must still be what the signal offers.
	call(itemID, f.recipientID, map[string]any{"index": 0, "content": "disagree"}, http.StatusConflict)
	call(itemID, f.recipientID, map[string]any{"index": 2, "content": "agree"}, http.StatusConflict)
	call(itemID, f.recipientID, map[string]any{"content": "agree"}, http.StatusConflict)
	// Not a signal.
	call(f.mentionID, f.recipientID, ok, http.StatusBadRequest)
	// A signal without replies.
	plain := f.raise(t, map[string]any{"key": "plain", "replies": nil})
	call(plain, f.recipientID, ok, http.StatusConflict)
	// A resolved ask.
	testutil.Call(t, signalHandler(testHandler.ResolveInboxSignal),
		signalRequest("/api/inbox/signals/resolve", f.botUserID, f.workspaceID,
			map[string]any{"recipient_member_id": f.recipientID, "key": "needs-human:CTG-1:c1"})).Want(http.StatusOK)
	call(itemID, f.recipientID, ok, http.StatusConflict)

	if n := dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id = $1 AND id <> $2`, f.issueID, f.askID); n != 0 {
		t.Fatalf("a refused click posted %d comments", n)
	}
}

// The comment handler's own refusal comes back unchanged and leaves the
// signal in place.
func TestInboxSignalReplyPassesCommentRefusalThrough(t *testing.T) {
	f := newReplyFixture(t)
	itemID := f.raise(t, nil)
	// The ask moved to another card after the signal was raised.
	otherIssue := dbfx.Issue(t, "Moved", testutil.Cols{"workspace_id": f.workspaceID})
	dbfx.Exec(t, `UPDATE comment SET issue_id = $1 WHERE id = $2`, otherIssue, f.askID)
	t.Cleanup(func() { dbfx.Exec(t, `DELETE FROM comment WHERE issue_id = $1`, otherIssue) })

	testutil.Call(t, replyHandler(), replyRequest(itemID, f.recipientID, f.workspaceID,
		map[string]any{"index": 0, "content": "agree"})).Want(http.StatusBadRequest)
	if dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE id = $1 AND NOT archived`, itemID) != 1 {
		t.Fatal("a failed post archived the signal")
	}
}

func TestSignalReplyAnswersItsAsk(t *testing.T) {
	f := newReplyFixture(t)
	dbfx.Cleanup(t, `DELETE FROM issue_ask WHERE issue_id = $1`, f.issueID)
	askRow := dbfx.Insert(t, "issue_ask", testutil.Cols{
		"workspace_id": f.workspaceID, "issue_id": f.issueID, "comment_id": f.askID, "author_type": "member",
		"author_id": f.botUserID, "addressee_type": "member", "addressee_id": f.recipientID, "kind": "decision",
		"topic": "Which copy?", "source": "cli",
	})
	replies := f.replies()
	replies[0]["ask_id"] = askRow
	itemID := f.raise(t, map[string]any{"replies": replies})

	testutil.Call(t, replyHandler(), replyRequest(itemID, f.recipientID, f.workspaceID, map[string]any{"index": 0, "content": "agree"})).
		Want(http.StatusCreated)

	var state, via, by, text string
	dbfx.QueryRow(t, `SELECT state, answered_via, answered_by::text, answer_text FROM issue_ask WHERE id = $1`, askRow).Scan(&state, &via, &by, &text)
	if state != "answered" || via != "one_tap" || by != f.recipientID || text != "agree" {
		t.Fatalf("got state=%s via=%s by=%s text=%s", state, via, by, text)
	}
}
