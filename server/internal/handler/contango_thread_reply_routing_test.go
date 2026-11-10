package handler

import (
	"context"
	"fmt"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Contango: a person's untagged reply from the thread's reply box wakes the last
// agent to speak in that thread and nobody else.

func insertThreadComment(t *testing.T, issueID, agentID, parentID, kind string) string {
	t.Helper()
	var id string
	var parent any
	if parentID != "" {
		parent = parentID
	}
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type, parent_id, created_at)
		VALUES ($1, $2, 'agent', $3, 'agent says', $4, $5, clock_timestamp())
		RETURNING id
	`, issueID, testWorkspaceID, agentID, kind, parent).Scan(&id); err != nil {
		t.Fatalf("insert agent comment: %v", err)
	}
	return id
}

type threadRoutingFixture struct {
	issueID, assignee, a, b, root string
}

func newThreadRoutingFixture(t *testing.T) threadRoutingFixture {
	t.Helper()
	f := threadRoutingFixture{
		assignee: createHandlerTestAgent(t, "Thread Routing Assignee", nil),
		a:        createHandlerTestAgent(t, "Thread Routing A", nil),
		b:        createHandlerTestAgent(t, "Thread Routing B", nil),
	}
	f.issueID = createCommentTriggerPreviewIssue(t, "thread routing", "agent", f.assignee)
	f.root = insertThreadComment(t, f.issueID, f.a, "", "comment")
	insertThreadComment(t, f.issueID, f.b, f.root, "comment")
	return f
}

func requireOnlyQueued(t *testing.T, f threadRoutingFixture, want string) {
	t.Helper()
	for _, id := range []string{f.assignee, f.a, f.b} {
		wantN := 0
		if id == want {
			wantN = 1
		}
		if got := countQueuedCommentTriggerTasks(t, f.issueID, id); got != wantN {
			t.Fatalf("agent %s queued = %d, want %d", id, got, wantN)
		}
	}
}

func TestThreadReply_WakesLastAgentOnly(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newThreadRoutingFixture(t)
	root := f.root
	preview := previewCommentTriggersForTest(t, f.issueID, CommentTriggerPreviewRequest{Content: "ok", ParentID: &root})
	requirePreviewAgents(t, preview, f.b)
	if preview.Agents[0].Source != string(commentTriggerSourceThreadLastAgent) {
		t.Fatalf("source = %q", preview.Agents[0].Source)
	}
	postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{"content": "ok", "parent_id": f.root})
	requireOnlyQueued(t, f, f.b)
}

func TestThreadReply_ReplyToThisCommentWakesItsAuthor(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newThreadRoutingFixture(t)
	root := f.root
	preview := previewCommentTriggersForTest(t, f.issueID, CommentTriggerPreviewRequest{Content: "ok", ParentID: &root, TargetsParent: true})
	requirePreviewAgents(t, preview, f.a)
	postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{"content": "ok", "parent_id": f.root, "targets_parent": true})
	requireOnlyQueued(t, f, f.a)
}

func TestThreadReply_NonRootParentCountsAsChosen(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newThreadRoutingFixture(t)
	mine := insertThreadComment(t, f.issueID, f.a, f.root, "comment")
	insertThreadComment(t, f.issueID, f.b, f.root, "comment")
	postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{"content": "ok", "parent_id": mine})
	requireOnlyQueued(t, f, f.a)
}

func TestThreadReply_ReplyToAPersonWakesNobody(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newThreadRoutingFixture(t)
	person := postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{"content": "/note a person", "parent_id": f.root})
	postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{"content": "ok", "parent_id": person, "targets_parent": true})
	requireOnlyQueued(t, f, "")
}

func TestThreadReply_ArchivedLastAgentFallsBack(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newThreadRoutingFixture(t)
	if _, err := testPool.Exec(context.Background(), `UPDATE agent SET archived_at = now() WHERE id = $1`, f.b); err != nil {
		t.Fatal(err)
	}
	postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{"content": "ok", "parent_id": f.root})
	requireOnlyQueued(t, f, f.a)
}

func TestThreadReply_AutomaticNoteIsNotTheLastAgent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newThreadRoutingFixture(t)
	insertThreadComment(t, f.issueID, f.a, f.root, "system")
	postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{"content": "ok", "parent_id": f.root})
	requireOnlyQueued(t, f, f.b)
}

func TestThreadReply_ExplicitTagStillWins(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	f := newThreadRoutingFixture(t)
	postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{
		"content": fmt.Sprintf("[@A](mention://agent/%s) ok", f.a), "parent_id": f.root,
	})
	requireOnlyQueued(t, f, f.a)
}

func TestThreadReply_RootOwnerKeptBeforeAnyAgentSpeaks(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	assignee := createHandlerTestAgent(t, "Thread In Flight Assignee", nil)
	kim := createHandlerTestAgent(t, "Thread In Flight Kim", nil)
	issueID := createCommentTriggerPreviewIssue(t, "thread in flight", "agent", assignee)
	root := postCommentForTriggerPreviewTest(t, issueID, map[string]any{"content": fmt.Sprintf("[@Kim](mention://agent/%s) look", kim)})
	if _, err := testPool.Exec(ctx, `UPDATE agent_task_queue SET status = 'completed' WHERE issue_id = $1`, issueID); err != nil {
		t.Fatal(err)
	}
	postCommentForTriggerPreviewTest(t, issueID, map[string]any{"content": "and also", "parent_id": root})
	if got := countQueuedCommentTriggerTasks(t, issueID, kim); got != 1 {
		t.Fatalf("Kim queued = %d, want 1", got)
	}
	if got := countQueuedCommentTriggerTasks(t, issueID, assignee); got != 0 {
		t.Fatalf("assignee queued = %d, want 0", got)
	}
}

// A replay or edit must resolve the agent as of when the comment was posted.
func TestThreadReply_ReplayResolvesAsOfPosting(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	f := newThreadRoutingFixture(t)
	reply := postCommentForTriggerPreviewTest(t, f.issueID, map[string]any{"content": "ok", "parent_id": f.root})
	insertThreadComment(t, f.issueID, f.a, f.root, "comment")

	issue, err := testHandler.Queries.GetIssue(ctx, parseUUID(f.issueID))
	if err != nil {
		t.Fatal(err)
	}
	parent, err := testHandler.Queries.GetComment(ctx, parseUUID(f.root))
	if err != nil {
		t.Fatal(err)
	}
	triggers, _ := testHandler.computeCommentAgentTriggers(ctx, issue, "ok", &parent, "member", testUserID, commentTriggerComputeOptions{
		ExcludeTriggerCommentID: parseUUID(reply),
		OriginatorUserID:        testUserID,
	})
	if len(triggers) != 1 || uuidToString(triggers[0].Agent.ID) != f.b {
		t.Fatalf("replay triggers = %+v, want only B", triggers)
	}
}

func agentReplyTriggersLeader(t *testing.T, issue db.Issue, parent *db.Comment, worker, taskID string) bool {
	t.Helper()
	triggers, _ := testHandler.computeCommentAgentTriggers(context.Background(), issue, "done", parent, "agent", worker, commentTriggerComputeOptions{
		AuthoringTaskID:  parseUUID(taskID),
		OriginatorUserID: testUserID,
	})
	return triggersContainIssueAssigneeSquadLeader(triggers)
}

// An agent answering the person whose thread reply woke it leaves the lead out;
// the same agent answering a run another agent started keeps the leader loop.
func TestThreadReply_AnswerToAPersonDoesNotWakeLead(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSquadCommentTriggerFixture(t)
	worker := createHandlerTestAgent(t, "Thread Answer Worker", nil)
	issueID := createCommentTriggerPreviewIssue(t, "thread answer", "squad", fx.SquadID)
	root := insertThreadComment(t, issueID, worker, "", "comment")
	person := postCommentForTriggerPreviewTest(t, issueID, map[string]any{"content": "please check", "parent_id": root})

	var taskID string
	if err := testPool.QueryRow(ctx, `SELECT id FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2 AND trigger_comment_id = $3`, issueID, worker, person).Scan(&taskID); err != nil {
		t.Fatalf("load person-started task: %v", err)
	}
	issue, err := testHandler.Queries.GetIssue(ctx, parseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	parent, err := testHandler.Queries.GetComment(ctx, parseUUID(person))
	if err != nil {
		t.Fatal(err)
	}
	if agentReplyTriggersLeader(t, issue, &parent, worker, taskID) {
		t.Fatal("answer to the person woke the lead")
	}

	delegation := insertThreadComment(t, issueID, fx.LeaderID, root, "comment")
	if _, err := testPool.Exec(ctx, `UPDATE agent_task_queue SET trigger_comment_id = $1 WHERE id = $2`, delegation, taskID); err != nil {
		t.Fatal(err)
	}
	if !agentReplyTriggersLeader(t, issue, &parent, worker, taskID) {
		t.Fatal("a worker result on a run another agent started must still wake the lead")
	}
}
