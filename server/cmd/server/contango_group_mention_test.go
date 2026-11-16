package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Contango patch 48: a @group mention notifies the group's people on duty, says
// "via @group", skips people on time off, and an agent can't flood a group.
func TestContangoGroupMention(t *testing.T) {
	groupMentionFlood = &groupMentionGuard{seen: map[string]map[string]time.Time{}}
	fx := workspaceFixture(t)
	onDuty := fx.User(t, "Group on duty", "contango-groupm-duty@multica.ai")
	away := fx.User(t, "Group away", "contango-groupm-away@multica.ai")
	fx.Member(t, testWorkspaceID, onDuty, "member")
	fx.Member(t, testWorkspaceID, away, "member")
	agentID := fx.Agent(t, "Group mention agent", "")
	var groupID string
	fx.QueryRow(t, `INSERT INTO member_group (workspace_id, handle, name) VALUES ($1, 'groupm', 'G') RETURNING id::text`,
		testWorkspaceID).Scan(&groupID)
	fx.Cleanup(t, `DELETE FROM member_group WHERE id = $1`, groupID)
	fx.Cleanup(t, `DELETE FROM member_group_member WHERE group_id = $1`, groupID)
	fx.Exec(t, `INSERT INTO member_group_member (group_id, workspace_id, user_id, position) VALUES ($1, $2, $3, 0), ($1, $2, $4, 1)`,
		groupID, testWorkspaceID, away, onDuty)
	today := time.Now().UTC().Format("2006-01-02")
	fx.Exec(t, `INSERT INTO member_time_off (workspace_id, user_id, starts_on, ends_on, source) VALUES ($1, $2, $3, $3, 'manual')`,
		testWorkspaceID, away, today)
	fx.Cleanup(t, `DELETE FROM member_time_off WHERE user_id = $1`, away)

	queries := db.New(testPool)
	bus := newNotificationBus(t, queries)
	content := "[@groupm](mention://group/" + groupID + ") can you add the DNS record?"
	post := func(authorType, authorID, title string) string {
		issueID := fx.Issue(t, title)
		fx.Cleanup(t, `DELETE FROM inbox_item WHERE issue_id = $1`, issueID)
		fx.Cleanup(t, `DELETE FROM issue_subscriber WHERE issue_id = $1`, issueID)
		commentID := fx.Comment(t, issueID, content, map[string]any{"author_type": authorType, "author_id": authorID})
		bus.Publish(events.Event{
			Type: protocol.EventCommentCreated, WorkspaceID: testWorkspaceID, ActorType: authorType, ActorID: authorID,
			Payload: map[string]any{
				"comment": handler.CommentResponse{ID: commentID, IssueID: issueID, AuthorType: authorType,
					AuthorID: authorID, Content: content, Type: "comment"},
				"issue_title": title, "issue_status": "todo",
			},
		})
		return issueID
	}

	issueID := post("member", testUserID, "Group mention by a person")
	if n := fx.Count(t, `SELECT count(*) FROM inbox_item WHERE issue_id = $1 AND recipient_id = $2 AND type = 'mentioned'`, issueID, away); n != 0 {
		t.Fatalf("away member got %d items", n)
	}
	var details []byte
	fx.QueryRow(t, `SELECT details FROM inbox_item WHERE issue_id = $1 AND recipient_id = $2 AND type = 'mentioned'`, issueID, onDuty).Scan(&details)
	var d struct {
		ViaGroup struct{ ID, Handle string } `json:"via_group"`
	}
	if err := json.Unmarshal(details, &d); err != nil || d.ViaGroup.ID != groupID || d.ViaGroup.Handle != "groupm" {
		t.Fatalf("details = %s, want via_group groupm", details)
	}
	if n := fx.Count(t, `SELECT count(*) FROM issue_subscriber WHERE issue_id = $1 AND user_type = 'group'`, issueID); n != 0 {
		t.Fatalf("group became a subscriber")
	}

	// An agent may mention the group on 5 cards in 10 minutes; the 6th notifies nobody.
	for i := 0; i < groupMentionBurstMax; i++ {
		id := post("agent", agentID, "Agent group mention")
		if n := fx.Count(t, `SELECT count(*) FROM inbox_item WHERE issue_id = $1 AND recipient_id = $2`, id, onDuty); n != 1 {
			t.Fatalf("agent mention %d: %d items, want 1", i+1, n)
		}
	}
	id := post("agent", agentID, "Agent group flood")
	if n := fx.Count(t, `SELECT count(*) FROM inbox_item WHERE issue_id = $1`, id); n != 0 {
		t.Fatalf("flooding agent mention made %d items", n)
	}
}

func TestGroupMentionGuardWindow(t *testing.T) {
	g := &groupMentionGuard{seen: map[string]map[string]time.Time{}}
	now := time.Now()
	for i := 0; i < groupMentionBurstMax; i++ {
		if !g.allow("a", "g", string(rune('a'+i)), now) {
			t.Fatalf("mention %d refused", i)
		}
	}
	if g.allow("a", "g", "z", now) {
		t.Fatal("6th card allowed")
	}
	if !g.allow("a", "g", "a", now) {
		t.Fatal("a card already counted was refused")
	}
	if !g.allow("a", "g", "z", now.Add(groupMentionBurstWindow+time.Second)) {
		t.Fatal("window did not expire")
	}
	if !g.allow("b", "g", "z", now) {
		t.Fatal("another author shares the budget")
	}
}
