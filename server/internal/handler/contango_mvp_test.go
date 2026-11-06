package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestIssueNumberFromKey(t *testing.T) {
	for in, want := range map[string]int32{"CTG-2386": 2386, "2386": 2386, " ctg-7 ": 7} {
		if got, ok := issueNumberFromKey(in); !ok || got != want {
			t.Fatalf("%q -> %d %v", in, got, ok)
		}
	}
	for _, in := range []string{"", "CTG-", "CTG-x", "CTG-0"} {
		if _, ok := issueNumberFromKey(in); ok {
			t.Fatalf("%q parsed", in)
		}
	}
}

// One MVP pillar with three cards: a blocker chain, an open human ask with a
// smart-inbox signal, status history for the burndown, and a home card.
func TestGetMVPComputesFromTheDatabase(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ws := dbfx.Workspace(t, "MVP page", "mvp-page-test", testutil.Cols{"issue_prefix": "MVP"})
	dbfx.Member(t, ws, testUserID, "owner")
	other := dbfx.User(t, "Bot", "mvp-bot@multica.ai")
	dbfx.Member(t, ws, other, "member")
	t.Setenv(botMemberIDsEnv, other)

	release := dbfx.Insert(t, "issue_property", testutil.Cols{"workspace_id": ws, "name": "Release", "type": "select",
		"config": testutil.Raw(`'{"options":[{"id":"opt-mvp","name":"MVP"},{"id":"opt-post","name":"Post-MVP"}]}'::jsonb`)})
	responsible := dbfx.Insert(t, "issue_property", testutil.Cols{"workspace_id": ws, "name": "Responsible human", "type": "actor"})
	needs := dbfx.Insert(t, "issue_property", testutil.Cols{"workspace_id": ws, "name": "Needs human", "type": "checkbox"})
	for key, cat := range map[string]string{"todo": "unstarted", "in_progress": "started", "done": "done", "cancelled": "closed", "held": "started"} {
		dbfx.Insert(t, "issue_status", testutil.Cols{"workspace_id": ws, "key": key, "name": key, "category": cat, "color": "#6b7280"})
	}

	props := func(extra string) testutil.Raw {
		return testutil.Raw(fmt.Sprintf(`'{%s}'::jsonb`, extra))
	}
	issue := func(n int, title, status, parent string, p testutil.Raw) string {
		cols := testutil.Cols{"workspace_id": ws, "number": n, "status": status, "properties": p,
			"created_at": testutil.Raw("now() - interval '40 days'")}
		if parent != "" {
			cols["parent_issue_id"] = parent
		}
		return dbfx.Issue(t, title, cols)
	}
	home := issue(1, "MVP definition", "todo", "", props(`"`+release+`":"opt-post"`))
	dbfx.Exec(t, `UPDATE issue SET description = 'Ship **it**' WHERE id = $1`, home)
	pillar := issue(2, "Pillar", "in_progress", "", props(`"`+release+`":"opt-mvp","`+responsible+`":"member:`+testUserID+`"`))
	a := issue(3, "A", "done", pillar, props(""))
	b := issue(4, "B", "in_progress", pillar, props(`"`+needs+`":true`))
	c := issue(5, "C", "todo", pillar, props(""))
	issue(6, "Elsewhere", "todo", "", props(`"`+release+`":"opt-post"`))
	dbfx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": c, "depends_on_issue_id": b, "type": "blocked_by"})

	dbfx.Insert(t, "activity_log", testutil.Cols{"workspace_id": ws, "issue_id": a, "action": "status_changed",
		"details": testutil.Raw(`'{"from":"in_progress","to":"done"}'::jsonb`), "created_at": testutil.Raw("now() - interval '3 days'")})

	ask := dbfx.Comment(t, b, "**[NEEDS HUMAN]** Approve the plan\n\nReply with `ok`", testutil.Cols{"workspace_id": ws,
		"author_type": "agent", "created_at": testutil.Raw("now() - interval '2 hours'")})
	// A bot member's later post does not answer it.
	dbfx.Comment(t, b, "PR_WATCH:ping", testutil.Cols{"workspace_id": ws, "author_id": other})
	dbfx.Insert(t, "inbox_item", testutil.Cols{"workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
		"type": "signal", "issue_id": b, "title": "ask",
		"details": testutil.Raw(fmt.Sprintf(`'{"key":"needs-human:MVP-4:%s","replies":[{"label":"Approve: ok","content":"ok","parent_comment_id":"%s"}]}'::jsonb`, ask, ask))})
	// An operator ask on the pillar, answered by an operator note.
	dbfx.Comment(t, pillar, "**[NEEDS OPERATOR]** Seat down", testutil.Cols{"workspace_id": ws, "author_type": "agent",
		"created_at": testutil.Raw("now() - interval '3 hours'")})
	dbfx.Comment(t, pillar, "Operator note (owner's admin session): fixed", testutil.Cols{"workspace_id": ws, "author_id": other})
	dbfx.Comment(t, pillar, "**[NEEDS HUMAN]** Which chains?", testutil.Cols{"workspace_id": ws, "author_type": "agent"})

	t.Setenv("MULTICA_MVP_HOME_ISSUE", "MVP-1")
	req := newRequest(http.MethodGet, "/api/mvp", nil)
	req.Header.Set("X-Workspace-ID", ws)
	w := httptest.NewRecorder()
	testHandler.GetMVP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GetMVP: %d %s", w.Code, w.Body.String())
	}
	var out MVPResponse
	if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.Configured || out.Home == nil || out.Home.Identifier != "MVP-1" || out.Home.Description != "Ship **it**" {
		t.Fatalf("config/home = %v %+v", out.Configured, out.Home)
	}
	if out.Totals.Total != 3 || out.Totals.Open != 2 || out.Totals.Done != 1 {
		t.Fatalf("totals = %+v", out.Totals)
	}
	if len(out.Pillars) != 1 || out.Pillars[0].Issue.Identifier != "MVP-2" || len(out.Pillars[0].OpenItems) != 2 {
		t.Fatalf("pillars = %+v", out.Pillars)
	}
	if len(out.CriticalPaths) != 1 || len(out.CriticalPaths[0].Issues) != 2 || out.CriticalPaths[0].Issues[0].ID != b {
		t.Fatalf("critical paths = %+v", out.CriticalPaths)
	}
	last := out.Burndown[len(out.Burndown)-1]
	if last.Open != 2 || last.Done != 1 || out.Burndown[0].Done != 0 || out.ETA.Done7 != 1 {
		t.Fatalf("burndown first %+v last %+v eta %+v", out.Burndown[0], last, out.ETA)
	}
	if len(out.Humans) != 1 || out.Humans[0].RecipientID != testUserID || out.Humans[0].CardsBlocked != 2 {
		t.Fatalf("humans = %+v", out.Humans)
	}
	h := out.Humans[0].Asks[0]
	if h.CommentID != ask || h.InboxItemID == "" || len(h.Replies) != 1 || h.Replies[0].Content != "ok" {
		t.Fatalf("ask = %+v", h)
	}
	if len(out.AgentQuestions) != 1 || out.AgentQuestions[0].Excerpt != "Which chains?" {
		t.Fatalf("agent questions = %+v", out.AgentQuestions)
	}
	// b had no run: an idle in-progress card.
	if len(out.Stuck.Idle) != 1 || out.Stuck.Idle[0].ID != b {
		t.Fatalf("idle = %+v", out.Stuck.Idle)
	}
}

func TestGetMVPUnconfiguredWorkspace(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ws := dbfx.Workspace(t, "MVP none", "mvp-page-none", testutil.Cols{"issue_prefix": "MVN"})
	t.Setenv("MULTICA_MVP_RELEASE_PROPERTY", "Milestone")
	req := newRequest(http.MethodGet, "/api/mvp", nil)
	req.Header.Set("X-Workspace-ID", ws)
	w := httptest.NewRecorder()
	testHandler.GetMVP(w, req)
	var out MVPResponse
	if w.Code != http.StatusOK || json.NewDecoder(w.Body).Decode(&out) != nil {
		t.Fatalf("GetMVP: %d %s", w.Code, w.Body.String())
	}
	if out.Configured || out.Problem == "" || out.Pillars == nil || out.Burndown == nil || out.Standalone.OpenItems == nil {
		t.Fatalf("out = %+v", out)
	}
}
