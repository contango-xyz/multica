package handler

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Contango (CTG-839): an agent's untagged reply to a human answers that human; it must not
// fall back to the assigned squad's leader. Replies under an agent comment, top-level agent
// comments and anything that names a target keep today's routing.
func TestAgentUntaggedReplyToMemberDoesNotWakeSquadLeader(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSquadCommentTriggerFixture(t)
	ctx := context.Background()
	issueID := uuidToString(fx.Issue.ID)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
	})

	asked := "[@Other](mention://agent/" + fx.OtherID + ") how does this card play with CTG-731?"
	member := &db.Comment{AuthorType: "member", AuthorID: util.MustParseUUID(testUserID), Content: asked}
	delegated := &db.Comment{AuthorType: "member", AuthorID: util.MustParseUUID(testUserID), Content: "Coordinate this work"}
	agent := &db.Comment{AuthorType: "agent", AuthorID: util.MustParseUUID(fx.OtherID)}
	deletedMember := &db.Comment{AuthorType: "member", AuthorID: util.MustParseUUID(testUserID), Content: asked,
		DeletedAt: pgtype.Timestamptz{Valid: true}}

	t.Run("untagged answer to a human who asked this agent does not wake the leader", func(t *testing.T) {
		if shouldEnqueueSquadLeaderOnReplyForTest(ctx, fx.Issue, "It is a child of CTG-731; closed.", member, "agent", fx.OtherID) {
			t.Fatal("expected no leader wake for an agent's answer to a human who named it")
		}
	})
	t.Run("a worker's reply under a human comment that did not name it still wakes the leader", func(t *testing.T) {
		if !shouldEnqueueSquadLeaderOnReplyForTest(ctx, fx.Issue, "The worker has results", delegated, "agent", fx.OtherID) {
			t.Fatal("expected the leader to wake: the leader delegated this, it is the worker→leader loop")
		}
	})
	t.Run("untagged agent reply to an agent still wakes the leader", func(t *testing.T) {
		if !shouldEnqueueSquadLeaderOnReplyForTest(ctx, fx.Issue, "pushed the fix", agent, "agent", fx.OtherID) {
			t.Fatal("expected the leader to wake for a worker result under an agent comment")
		}
	})
	t.Run("top-level untagged agent comment still wakes the leader", func(t *testing.T) {
		if !shouldEnqueueSquadLeaderOnCommentForTest(ctx, fx.Issue, "PR is up", "agent", fx.OtherID) {
			t.Fatal("expected the leader to wake for a top-level worker comment")
		}
	})
	t.Run("a reply to a deleted human comment keeps today's routing", func(t *testing.T) {
		if !shouldEnqueueSquadLeaderOnReplyForTest(ctx, fx.Issue, "PR is up", deletedMember, "agent", fx.OtherID) {
			t.Fatal("expected the leader to wake: a deleted parent does not make it a reply to a human")
		}
	})
	t.Run("an agent reply to a human that names the leader still reaches it", func(t *testing.T) {
		content := "[@Lead](mention://agent/" + fx.LeaderID + ") please route this"
		triggers, _ := testHandler.computeCommentAgentTriggers(ctx, fx.Issue, content, member, "agent", fx.OtherID, commentTriggerComputeOptions{})
		found := false
		for _, tr := range triggers {
			if uuidToString(tr.Agent.ID) == fx.LeaderID {
				found = true
			}
		}
		if !found {
			t.Fatal("expected an explicit mention to keep routing to the named agent")
		}
	})
	t.Run("classification", func(t *testing.T) {
		f := agentAnswersMemberWhoNamedIt
		if f(nil, fx.OtherID) || !f(member, fx.OtherID) || f(member, fx.LeaderID) || f(delegated, fx.OtherID) ||
			f(agent, fx.OtherID) || f(deletedMember, fx.OtherID) {
			t.Fatal("agentAnswersMemberWhoNamedIt: wrong classification")
		}
	})
}
