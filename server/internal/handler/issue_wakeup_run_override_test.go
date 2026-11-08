package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type runOverrideFixture struct {
	issue, agent, seat string
}

func newRunOverrideFixture(t *testing.T, seatCols testutil.Cols) runOverrideFixture {
	t.Helper()
	own := dbfx.Runtime(t, "own seat", testutil.Cols{"provider": "claude", "visibility": "public"})
	seat := dbfx.Runtime(t, "audit seat", testutil.Cols{"provider": "claude", "visibility": "public"}, seatCols)
	agent := dbfx.Agent(t, "override agent", own, testutil.Cols{"model": "claude-sonnet-5", "thinking_level": "low", "service_tier": "fast", "max_concurrent_tasks": 4})
	issue := dbfx.Issue(t, "run override")
	dbfx.Cleanup(t, "DELETE FROM issue_wakeup WHERE issue_id=$1", issue)
	dbfx.Cleanup(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id IN(SELECT id FROM issue_wakeup WHERE issue_id=$1)", issue)
	dbfx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	return runOverrideFixture{issue: issue, agent: agent, seat: seat}
}

func (f runOverrideFixture) body(extra map[string]any) map[string]any {
	body := map[string]any{"agent_id": f.agent, "instruction": "audit", "runtime_id": f.seat, "model": "claude-opus-5", "thinking_level": "high"}
	for k, v := range extra {
		if v == nil {
			delete(body, k)
		} else {
			body[k] = v
		}
	}
	return body
}

func runOverrideWake(f runOverrideFixture, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	testHandler.WakeIssueAgentNow(rec, withURLParam(req, "id", f.issue))
	return rec
}

func wakeNowReq(f runOverrideFixture, extra map[string]any) *http.Request {
	return newRequest("POST", "/api/issues/"+f.issue+"/wakeups/now", f.body(extra))
}

func TestRunOverrideRefusalsAreStatusCoded(t *testing.T) {
	f := newRunOverrideFixture(t, nil)
	t.Run("off switch", func(t *testing.T) {
		t.Setenv("MULTICA_RUN_OVERRIDES", "0")
		if rec := runOverrideWake(f, wakeNowReq(f, nil)); rec.Code != 403 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("machine credential", func(t *testing.T) {
		req := wakeNowReq(f, nil)
		req.Header.Set("X-Actor-Source", "task_token")
		req.Header.Set("X-Agent-ID", f.agent)
		if rec := runOverrideWake(f, req); rec.Code != 403 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
		req = wakeNowReq(f, nil)
		req.Header.Set("X-Actor-Source", "cloud_pat")
		if rec := runOverrideWake(f, req); rec.Code != 403 {
			t.Fatalf("cloud_pat %d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("agent identity on a human token", func(t *testing.T) {
		req := wakeNowReq(f, nil)
		var taskID string
		dbfx.QueryRow(t, `INSERT INTO agent_task_queue(agent_id,runtime_id,issue_id,status,priority) VALUES($1,$2,$3,'running',0) RETURNING id`, f.agent, f.seat, f.issue).Scan(&taskID)
		t.Cleanup(func() { testPool.Exec(context.Background(), "DELETE FROM agent_task_queue WHERE id=$1", taskID) })
		req.Header.Set("X-Agent-ID", f.agent)
		req.Header.Set("X-Task-ID", taskID)
		if rec := runOverrideWake(f, req); rec.Code != 403 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("unknown runtime", func(t *testing.T) {
		if rec := runOverrideWake(f, wakeNowReq(f, map[string]any{"runtime_id": "00000000-0000-0000-0000-00000000dead"})); rec.Code != 400 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("foreign model family", func(t *testing.T) {
		if rec := runOverrideWake(f, wakeNowReq(f, map[string]any{"model": "gpt-5.5"})); rec.Code != 400 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("literal effort", func(t *testing.T) {
		if rec := runOverrideWake(f, wakeNowReq(f, map[string]any{"thinking_level": "enormous"})); rec.Code != 400 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("effort not offered by the model", func(t *testing.T) {
		cache := NewInMemoryModelCatalogCache()
		orig := testHandler.ModelCatalogCache
		testHandler.ModelCatalogCache = cache
		t.Cleanup(func() { testHandler.ModelCatalogCache = orig })
		if err := cache.Put(context.Background(), f.seat, []ModelEntry{{ID: "claude-opus-5", Thinking: &ModelThinking{SupportedLevels: []ThinkingLevel{{Value: "high"}}}}}, nil, true); err != nil {
			t.Fatal(err)
		}
		if rec := runOverrideWake(f, wakeNowReq(f, map[string]any{"thinking_level": "max"})); rec.Code != 400 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
		if rec := runOverrideWake(f, wakeNowReq(f, map[string]any{"model": "claude-future-9", "thinking_level": "max"})); rec.Code != 201 {
			t.Fatalf("model missing from the catalog should pass: %d: %s", rec.Code, rec.Body.String())
		}
		dbfx.Exec(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", f.issue)
		dbfx.Exec(t, "DELETE FROM issue_wakeup WHERE issue_id=$1", f.issue)
	})
	t.Run("offline seat is 409", func(t *testing.T) {
		dbfx.Exec(t, "UPDATE agent_runtime SET status='offline' WHERE id=$1", f.seat)
		t.Cleanup(func() { dbfx.Exec(t, "UPDATE agent_runtime SET status='online' WHERE id=$1", f.seat) })
		if rec := runOverrideWake(f, wakeNowReq(f, nil)); rec.Code != 409 {
			t.Fatalf("%d: %s", rec.Code, rec.Body.String())
		}
	})
}

func TestRunOverrideRequiresManagingTheAgentAndRuntimeAccess(t *testing.T) {
	f := newRunOverrideFixture(t, nil)
	member := dbfx.User(t, "pin member", "pin-member@multica.test")
	dbfx.Member(t, testWorkspaceID, member, "member")
	req := newRequestAs(member, "POST", "/api/issues/"+f.issue+"/wakeups/now", f.body(nil))
	if rec := runOverrideWake(f, req); rec.Code != 403 {
		t.Fatalf("non-manager %d: %s", rec.Code, rec.Body.String())
	}

	stranger := dbfx.User(t, "seat owner", "pin-owner@multica.test")
	dbfx.Member(t, testWorkspaceID, stranger, "member")
	private := dbfx.Runtime(t, "private seat", testutil.Cols{"provider": "claude", "visibility": "private", "owner_id": stranger})
	rec := runOverrideWake(f, wakeNowReq(f, map[string]any{"runtime_id": private}))
	if rec.Code != 403 {
		t.Fatalf("private seat %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRunOverrideAPIQueuesPinnedRunAndClaimDeliversOverride(t *testing.T) {
	f := newRunOverrideFixture(t, nil)
	rec := runOverrideWake(f, wakeNowReq(f, nil))
	if rec.Code != http.StatusCreated {
		t.Fatalf("%d: %s", rec.Code, rec.Body.String())
	}
	var result service.WakeupNowResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || result.Outcome != service.WakeupNowQueued || result.TaskID == "" {
		t.Fatalf("result = %+v err=%v", result, err)
	}

	// A second override while the first waits is refused, never joined.
	if second := runOverrideWake(f, wakeNowReq(f, nil)); second.Code != 409 {
		t.Fatalf("second override %d: %s", second.Code, second.Body.String())
	}

	// The seat's daemon claims and receives the override, not the agent's settings.
	claim := httptest.NewRecorder()
	req := withURLParam(newOwnerDaemonRequest("POST", "/api/daemon/runtimes/"+f.seat+"/tasks/claim", nil), "runtimeId", f.seat)
	testHandler.ClaimTaskByRuntime(claim, req)
	if claim.Code != 200 {
		t.Fatalf("claim %d: %s", claim.Code, claim.Body.String())
	}
	var got struct {
		Task *AgentTaskResponse `json:"task"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &got); err != nil || got.Task == nil || got.Task.Agent == nil {
		t.Fatalf("claim body: %s err=%v", claim.Body.String(), err)
	}
	if got.Task.ID != result.TaskID || got.Task.Agent.Model != "claude-opus-5" || got.Task.Agent.ThinkingLevel != "high" || got.Task.Agent.ServiceTier != "" {
		t.Fatalf("delivered id=%s model=%q level=%q tier=%q", got.Task.ID, got.Task.Agent.Model, got.Task.Agent.ThinkingLevel, got.Task.Agent.ServiceTier)
	}
	if got.Task.PriorSessionID != "" {
		t.Fatalf("override run resumed session %q", got.Task.PriorSessionID)
	}
	if strings.Contains(claim.Body.String(), "error_agent_runtime_changed") {
		t.Fatalf("delivery gate refused pinned run: %s", claim.Body.String())
	}
	// Agent settings are untouched.
	var model string
	dbfx.QueryRow(t, "SELECT COALESCE(model,'') FROM agent WHERE id=$1", f.agent).Scan(&model)
	if model != "claude-sonnet-5" {
		t.Fatalf("agent model changed to %q", model)
	}
}

func TestRunOverrideOmittedFieldsCarryAgentValuesAndDropForeignModel(t *testing.T) {
	f := newRunOverrideFixture(t, testutil.Cols{"provider": "codex"})
	rec := runOverrideWake(f, wakeNowReq(f, map[string]any{"model": nil, "thinking_level": nil}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("%d: %s", rec.Code, rec.Body.String())
	}
	var result service.WakeupNowResult
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	var raw []byte
	dbfx.QueryRow(t, "SELECT context FROM agent_task_queue WHERE id=$1", result.TaskID).Scan(&raw)
	var ctx struct {
		Override service.RunOverride `json:"run_override"`
	}
	if err := json.Unmarshal(raw, &ctx); err != nil {
		t.Fatal(err)
	}
	if ctx.Override.Model != "" || ctx.Override.ThinkingLevel != "low" || ctx.Override.RuntimeID != f.seat {
		t.Fatalf("override = %+v", ctx.Override)
	}
}

func TestPinnedRunOnPrivateForeignRuntimeIsFailedAtDeliveryGate(t *testing.T) {
	// The private-runtime owner check stays for pinned runs even when the
	// request-time check is bypassed (for example, access revoked afterwards).
	f := newRunOverrideFixture(t, nil)
	stranger := dbfx.User(t, "owner gate", "pin-gate@multica.test")
	dbfx.Member(t, testWorkspaceID, stranger, "member")
	private := dbfx.Runtime(t, "gate seat", testutil.Cols{"provider": "claude", "visibility": "private", "owner_id": stranger})
	dbfx.Exec(t, "UPDATE agent SET owner_id=$2 WHERE id=$1", f.agent, testUserID)
	var taskID string
	dbfx.QueryRow(t, `INSERT INTO agent_task_queue(agent_id,runtime_id,issue_id,status,priority,context) VALUES($1,$2,$3,'queued',0,'{"run_override":{"runtime_id":"x","model":"","thinking_level":""}}') RETURNING id`, f.agent, private, f.issue).Scan(&taskID)
	req := newRequestAs(stranger, "POST", "/api/daemon/runtimes/"+private+"/tasks/claim", nil)
	claim := httptest.NewRecorder()
	testHandler.ClaimTaskByRuntime(claim, withURLParam(req, "runtimeId", private))
	var status string
	dbfx.QueryRow(t, "SELECT status FROM agent_task_queue WHERE id=$1", taskID).Scan(&status)
	if status != "failed" {
		t.Fatalf("status %q; claim %d: %s", status, claim.Code, claim.Body.String())
	}
}
