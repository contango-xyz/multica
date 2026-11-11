package main

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Contango patch 41 (owner 2026-11-11: 28 @all comments from the PM agent made
// 252 inbox notifications). Only a member's @all fans out to the workspace; an
// agent's @all notifies nobody, while its direct mentions still do.
func TestContangoAgentMentionAll(t *testing.T) {
	for _, tc := range []struct {
		name          string
		authorType    string
		withDirect    bool
		wantBystander int // inbox items for a member nobody named
		wantNamed     int // inbox items for the member named directly
	}{
		{name: "agent @all notifies nobody", authorType: "agent", wantBystander: 0},
		{name: "agent direct mentions still notify", authorType: "agent", withDirect: true, wantBystander: 0, wantNamed: 1},
		{name: "member @all still notifies", authorType: "member", wantBystander: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := workspaceFixture(t)
			bystander := fx.User(t, "All bystander", "contango-all-bystander@multica.ai")
			named := fx.User(t, "All named", "contango-all-named@multica.ai")
			fx.Member(t, testWorkspaceID, bystander, "member")
			fx.Member(t, testWorkspaceID, named, "member")
			agentID := fx.Agent(t, "All author agent", "")
			otherAgent := fx.Agent(t, "All card agent", "")
			issueID := fx.Issue(t, "Agent @all")
			fx.Cleanup(t, `DELETE FROM inbox_item WHERE issue_id = $1`, issueID)
			fx.Cleanup(t, `DELETE FROM issue_subscriber WHERE issue_id = $1`, issueID)

			authorID := testUserID
			if tc.authorType == "agent" {
				authorID = agentID
			}
			content := "[@all](mention://all/all) test-env rules"
			if tc.withDirect {
				content += " [@Named](mention://member/" + named + ") [@Card agent](mention://agent/" + otherAgent + ")"
			}
			commentID := fx.Comment(t, issueID, content, map[string]any{
				"author_type": tc.authorType, "author_id": authorID,
			})

			queries := db.New(testPool)
			bus := newNotificationBus(t, queries)
			bus.Publish(events.Event{
				Type: protocol.EventCommentCreated, WorkspaceID: testWorkspaceID,
				ActorType: tc.authorType, ActorID: authorID,
				Payload: map[string]any{
					"comment": handler.CommentResponse{
						ID: commentID, IssueID: issueID, AuthorType: tc.authorType,
						AuthorID: authorID, Content: content, Type: "comment",
					},
					"issue_title": "Agent @all", "issue_status": "todo",
				},
			})

			if got := len(inboxItemsForRecipient(t, queries, bystander)); got != tc.wantBystander {
				t.Fatalf("bystander got %d inbox items, want %d", got, tc.wantBystander)
			}
			if got := len(inboxItemsForRecipient(t, queries, named)); got != tc.wantNamed+tc.wantBystander {
				t.Fatalf("named member got %d inbox items, want %d", got, tc.wantNamed+tc.wantBystander)
			}
			if tc.authorType == "agent" {
				want := tc.wantNamed
				if n := fx.Count(t, `SELECT count(*) FROM inbox_item WHERE issue_id = $1 AND type = 'mentioned'`, issueID); n != want {
					t.Fatalf("issue has %d mention inbox items, want %d", n, want)
				}
			}
		})
	}
}

// The issue-description path shares notifyMentionedMembers: an agent's @all in
// a description notifies nobody, a member's does.
func TestContangoAgentMentionAllDescription(t *testing.T) {
	fx := workspaceFixture(t)
	bystander := fx.User(t, "Desc bystander", "contango-all-desc@multica.ai")
	fx.Member(t, testWorkspaceID, bystander, "member")
	agentID := fx.Agent(t, "Desc agent", "")
	queries := db.New(testPool)
	mentions := parseMentions("[@all](mention://all/all)")

	issueID := fx.Issue(t, "Agent desc @all")
	fx.Cleanup(t, `DELETE FROM inbox_item WHERE issue_id = $1`, issueID)
	notifyMentionedMembers(newNotificationBus(t, queries), queries,
		events.Event{WorkspaceID: testWorkspaceID, ActorType: "agent", ActorID: agentID},
		mentions, issueID, "Agent desc @all", "todo", "Agent desc @all", map[string]bool{}, emptyDetails)
	if n := fx.Count(t, `SELECT count(*) FROM inbox_item WHERE issue_id = $1`, issueID); n != 0 {
		t.Fatalf("agent description @all made %d inbox items, want 0", n)
	}

	memberIssue := fx.Issue(t, "Member desc @all")
	fx.Cleanup(t, `DELETE FROM inbox_item WHERE issue_id = $1`, memberIssue)
	notifyMentionedMembers(newNotificationBus(t, queries), queries,
		events.Event{WorkspaceID: testWorkspaceID, ActorType: "member", ActorID: testUserID},
		mentions, memberIssue, "Member desc @all", "todo", "Member desc @all", map[string]bool{}, emptyDetails)
	if got := len(inboxItemsForRecipient(t, queries, bystander)); got != 1 {
		t.Fatalf("member description @all: bystander got %d inbox items, want 1", got)
	}
}
