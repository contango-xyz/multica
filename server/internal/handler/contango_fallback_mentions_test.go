package handler

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// Contango (CTG-281): a run that posts nothing itself gets its final output
// posted as a fallback comment. An explicit @agent in that comment must start
// the named agent, as the same text posted with `multica issue comment add`
// does; an untagged final message still starts nobody.
func TestFallbackCommentMentionsStartTheirTargets(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	for _, tc := range []struct {
		name    string
		mention bool
	}{{"explicit mention", true}, {"untagged", false}} {
		t.Run(tc.name, func(t *testing.T) {
			leadRuntime := dbfx.Runtime(t, "Fallback mention lead runtime")
			leadID := dbfx.Agent(t, "Fallback lead", leadRuntime)
			pmRuntime := dbfx.Runtime(t, "Fallback mention pm runtime")
			pmID := dbfx.Agent(t, "Fallback pm", pmRuntime)
			squadID := dbfx.Squad(t, "Fallback mention squad", leadID)
			dbfx.SquadMember(t, squadID, "agent", pmID)
			issueID := dbfx.Issue(t, "Every child is done", testutil.Cols{
				"status": "in_progress_epics", "assignee_type": "squad", "assignee_id": squadID,
			})
			taskID := dbfx.Task(t, leadID, testutil.Cols{
				"runtime_id": leadRuntime, "issue_id": issueID, "status": "running", "started_at": "now()",
				"is_leader_task": true, "squad_id": squadID,
				"originator_user_id": testUserID, "accountable_user_id": testUserID,
			})
			output := "All six children are Done; please confirm epic closeout."
			if tc.mention {
				output = fmt.Sprintf("[@PM](mention://agent/%s) %s", pmID, output)
			}
			req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/tasks/"+taskID+"/complete",
				map[string]any{"output": output}, testWorkspaceID, "fallback-mentions")
			req = withURLParam(req, "taskId", taskID)
			testutil.Call(t, testHandler.CompleteTask, req).Want(http.StatusOK)

			var fallbackID string
			dbfx.QueryRow(t, `SELECT id FROM comment WHERE issue_id = $1 AND author_id = $2 AND source_task_id = $3`,
				issueID, leadID, taskID).Scan(&fallbackID)
			var pmRuns, leadRuns int
			dbfx.QueryRow(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2 AND trigger_comment_id = $3`,
				issueID, pmID, fallbackID).Scan(&pmRuns)
			dbfx.QueryRow(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2 AND id <> $3`,
				issueID, leadID, taskID).Scan(&leadRuns)
			want := 0
			if tc.mention {
				want = 1
			}
			if pmRuns != want {
				t.Fatalf("PM runs from the fallback comment = %d, want %d", pmRuns, want)
			}
			if leadRuns != 0 {
				t.Fatalf("the lead's own fallback comment must not start the lead again (%d runs)", leadRuns)
			}
		})
	}
}
