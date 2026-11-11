package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Contango patch 40: an agent may manage a wakeup on its card when it registered
// it, its squad has the card, or it acts for the card's responsible human.
func TestIssueWakeupManageBySquadAgents(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	creator := dbfx.User(t, "wake creator", "wake-creator-p40@multica.test")
	dbfx.Member(t, testWorkspaceID, creator, "member")
	someone := dbfx.User(t, "wake someone", "wake-someone-p40@multica.test")
	dbfx.Member(t, testWorkspaceID, someone, "member")
	responsible := dbfx.User(t, "wake responsible", "wake-responsible-p40@multica.test")
	dbfx.Member(t, testWorkspaceID, responsible, "member")

	sourceAgent := dbfx.Agent(t, "p40 source", testRuntimeID)
	squadAgent := dbfx.Agent(t, "p40 squad", testRuntimeID)
	leader := dbfx.Agent(t, "p40 leader", testRuntimeID)
	outsider := dbfx.Agent(t, "p40 outsider", testRuntimeID)
	squad := dbfx.Squad(t, "p40 squad", leader)
	dbfx.SquadMember(t, squad, "agent", squadAgent)

	prop := dbfx.Insert(t, "issue_property", testutil.Cols{"workspace_id": testWorkspaceID, "name": "Responsible Human", "type": "actor", "config": testutil.Raw("'{}'::jsonb")})
	issue := dbfx.Issue(t, "p40 card", testutil.Cols{"assignee_type": "squad", "assignee_id": squad})
	dbfx.Exec(t, "UPDATE issue SET properties=jsonb_build_object($2::text,'member:'||$3::text) WHERE id=$1", issue, prop, responsible)
	dbfx.Cleanup(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id IN(SELECT id FROM issue_wakeup WHERE issue_id=$1)", issue)
	dbfx.Cleanup(t, "DELETE FROM issue_wakeup WHERE issue_id=$1", issue)

	run := func(agent, originator string) string {
		return dbfx.Task(t, agent, testutil.Cols{"runtime_id": testRuntimeID, "issue_id": issue, "status": "running", "started_at": testutil.Raw("now()"), "originator_user_id": originator, "accountable_user_id": originator})
	}
	sourceRun := run(sourceAgent, someone)
	svc := service.IssueWakeupService{Tasks: testHandler.TaskService}
	target := dbfx.Agent(t, "p40 target", testRuntimeID)
	w, err := svc.Create(ctx, parseUUID(issue), parseUUID(testUserID), pgtype.UUID{}, service.WakeupInput{AgentID: target, Kind: "at", AfterSeconds: 600, Instruction: "check"})
	if err != nil {
		t.Fatal(err)
	}
	// Re-enable and edit re-check that the acting human may invoke the target.
	dbfx.Exec(t, "UPDATE agent SET owner_id=$2 WHERE id=$1", target, someone)
	// The rule belongs to another human, as when a teammate's run registered it.
	reset := func() int64 {
		var rev int64
		dbfx.QueryRow(t, "UPDATE issue_wakeup SET created_by=$2,source_task_id=$3,enabled=true,disabled_at=NULL WHERE id=$1 RETURNING revision", w.ID, creator, sourceRun).Scan(&rev)
		return rev
	}
	wakeupID := uuidToString(w.ID)
	disable := func(name, agent, originator string, want int) {
		t.Helper()
		reset()
		req := withURLParams(newRequest("POST", "/", nil), "id", issue, "wakeupID", wakeupID)
		if agent != "" {
			req.Header.Set("X-Agent-ID", agent)
			req.Header.Set("X-Task-ID", run(agent, originator))
			req.Header.Set("X-Actor-Source", "task_token")
		} else {
			req.Header.Set("X-User-ID", originator)
		}
		rec := httptest.NewRecorder()
		testHandler.DisableIssueWakeup(rec, req)
		if rec.Code != want {
			t.Fatalf("%s: disable %d, want %d: %s", name, rec.Code, want, rec.Body.String())
		}
		if want == 200 {
			var out db.IssueWakeup
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Enabled {
				t.Fatalf("%s: still enabled (%v)", name, err)
			}
		}
	}

	disable("unrelated agent", outsider, someone, 403)
	disable("plain member", "", someone, 403)
	disable("responsible human without an agent", "", responsible, 403)
	disable("source agent", sourceAgent, someone, 200)
	disable("squad member agent", squadAgent, someone, 200)
	disable("squad leader", leader, someone, 200)
	disable("agent acting for the responsible human", outsider, responsible, 200)
	disable("creator", "", creator, 200)

	// Re-enable and edit go through the same check.
	rev := reset()
	dbfx.Exec(t, "UPDATE issue_wakeup SET enabled=false,disabled_at=now() WHERE id=$1", w.ID)
	enable := func(agent string, want int) {
		t.Helper()
		req := withURLParams(newRequest("POST", "/", map[string]any{"revision": rev}), "id", issue, "wakeupID", wakeupID)
		req.Header.Set("X-Agent-ID", agent)
		req.Header.Set("X-Task-ID", run(agent, someone))
		req.Header.Set("X-Actor-Source", "task_token")
		rec := httptest.NewRecorder()
		testHandler.EnableIssueWakeup(rec, req)
		if rec.Code != want {
			t.Fatalf("enable by %s: %d, want %d: %s", agent, rec.Code, want, rec.Body.String())
		}
	}
	enable(outsider, 403)
	enable(squadAgent, 200)

	rev = reset()
	edit := func(agent string, want int) {
		t.Helper()
		req := withURLParams(newRequest("PATCH", "/", map[string]any{"instruction": "check again", "expected_instruction": "check", "revision": rev}), "id", issue, "wakeupID", wakeupID)
		req.Header.Set("X-Agent-ID", agent)
		req.Header.Set("X-Task-ID", run(agent, someone))
		req.Header.Set("X-Actor-Source", "task_token")
		rec := httptest.NewRecorder()
		testHandler.EditIssueWakeupInstruction(rec, req)
		if rec.Code != want {
			t.Fatalf("edit by %s: %d, want %d: %s", agent, rec.Code, want, rec.Body.String())
		}
	}
	edit(outsider, 403)
	edit(squadAgent, 204)
}
