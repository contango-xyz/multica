package handler

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Contango patch 37 (owner 2026-11-10): operator asks and status-only notes never wake the squad leader.
func TestOperatorAskAndStatusOnlyComments(t *testing.T) {
	for _, c := range []struct {
		text string
		op   bool
		st   bool
	}{
		{"[NEEDS OPERATOR] quote-check fails", true, false},
		{"**[NEEDS OPERATOR]** CTG-1 broker down", true, false},
		{"/note [NEEDS OPERATOR] x", true, false},
		{"see the [NEEDS OPERATOR] above", false, false},
		{"Waiting for the pr-3632 preview of ed788eb", false, true},
		{"**Still waiting** on the parent.", false, true},
		{"Ask withdrawn: the operator answered.", false, true},
		{"Nothing is needed from you.", false, true},
		{"FM-PASS on the reservation head", false, false},
		{"Rebased onto main; waiting for CI is next", false, false},
		{"PLAN - CTG-1 waiting for review", false, false},
	} {
		if got := isOperatorAskComment(c.text); got != c.op {
			t.Errorf("isOperatorAskComment(%q) = %v, want %v", c.text, got, c.op)
		}
		if got := isStatusOnlyAgentComment(c.text); got != c.st {
			t.Errorf("isStatusOnlyAgentComment(%q) = %v, want %v", c.text, got, c.st)
		}
	}
}

// A top-level agent answer whose run was started by a human comment naming the agent does not wake the leader.
func TestAgentRunAnswersMemberWhoNamedIt(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSquadCommentTriggerFixture(t)
	ctx := context.Background()
	issueID := uuidToString(fx.Issue.ID)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM comment WHERE issue_id = $1`, issueID)
	})
	newComment := func(content string) string {
		var id string
		if err := testPool.QueryRow(ctx, `INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type)
			VALUES ($1, $2, 'member', $3, $4, 'comment') RETURNING id`, issueID, uuidToString(fx.Issue.WorkspaceID), testUserID, content).Scan(&id); err != nil {
			t.Fatalf("insert comment: %v", err)
		}
		return id
	}
	newTask := func(commentID string) pgtype.UUID {
		var id string
		if err := testPool.QueryRow(ctx, `INSERT INTO agent_task_queue (agent_id, issue_id, status, priority, trigger_comment_id, completed_at)
			VALUES ($1, $2, 'completed', 0, $3, now()) RETURNING id`, fx.OtherID, issueID, commentID).Scan(&id); err != nil {
			t.Fatalf("insert task: %v", err)
		}
		return util.MustParseUUID(id)
	}
	named := newTask(newComment("[@Other](mention://agent/" + fx.OtherID + ") what do you think?"))
	unnamed := newTask(newComment("Coordinate this work"))
	if !testHandler.agentRunAnswersMemberWhoNamedIt(ctx, named, fx.OtherID) {
		t.Fatal("a run started by a human naming the agent should count as answering that human")
	}
	if testHandler.agentRunAnswersMemberWhoNamedIt(ctx, unnamed, fx.OtherID) {
		t.Fatal("a run started by a human comment that did not name the agent is a worker result")
	}
	if testHandler.agentRunAnswersMemberWhoNamedIt(ctx, pgtype.UUID{}, fx.OtherID) {
		t.Fatal("no authoring task: false")
	}
}

// Owner 2026-11-10: a new top-level comment with no tag goes to the squad leader; an untagged reply in a thread goes
// to the agent that thread is with, never the leader; an explicit mention always wins.
func TestMemberCommentRoutingTopLevelVsThread(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSquadCommentTriggerFixture(t)
	ctx := context.Background()
	issueID := uuidToString(fx.Issue.ID)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM comment WHERE issue_id = $1`, issueID)
	})
	if _, err := testPool.Exec(ctx, `UPDATE agent SET runtime_id = (SELECT runtime_id FROM agent WHERE id = $1) WHERE id = $2`, fx.LeaderID, fx.OtherID); err != nil {
		t.Fatalf("runtime: %v", err)
	}
	insert := func(authorType, authorID, content string, parent string) db.Comment {
		var id string
		var p any
		if parent != "" {
			p = parent
		}
		if err := testPool.QueryRow(ctx, `INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type, parent_id)
			VALUES ($1, $2, $3, $4, $5, 'comment', $6) RETURNING id`, issueID, uuidToString(fx.Issue.WorkspaceID), authorType, authorID, content, p).Scan(&id); err != nil {
			t.Fatalf("insert comment: %v", err)
		}
		c, err := testHandler.Queries.GetComment(ctx, util.MustParseUUID(id))
		if err != nil {
			t.Fatalf("load comment: %v", err)
		}
		return c
	}
	agents := func(content string, parent *db.Comment) []string {
		triggers, _ := testHandler.computeCommentAgentTriggers(ctx, fx.Issue, content, parent, "member", testUserID, commentTriggerComputeOptions{})
		var ids []string
		for _, tr := range triggers {
			ids = append(ids, uuidToString(tr.Agent.ID))
		}
		return ids
	}
	// A thread the worker has answered in.
	root := insert("member", testUserID, "How do fees work?", "")
	insert("agent", fx.OtherID, "Here is the analysis.", uuidToString(root.ID))
	// (1) a new top-level comment with no tag: the leader, even though a worker spoke last on the card.
	if got := agents("and the timing?", nil); len(got) != 1 || got[0] != fx.LeaderID {
		t.Fatalf("top-level untagged: want the leader, got %v", got)
	}
	// (2) an untagged reply in that thread: the worker the thread is with, not the leader.
	if got := agents("ok, and what about the fees?", &root); len(got) != 1 || got[0] != fx.OtherID {
		t.Fatalf("thread reply: want the thread's agent, got %v", got)
	}
	// (3) an explicit mention wins, top-level or in the thread.
	tag := "[@Lead](mention://agent/" + fx.LeaderID + ") please route"
	if got := agents(tag, &root); len(got) != 1 || got[0] != fx.LeaderID {
		t.Fatalf("tagged reply: want the tagged agent, got %v", got)
	}
}
