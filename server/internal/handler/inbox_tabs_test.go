package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// tabsOn turns the inbox-tabs flag on for the fixture's recipient for this test.
func tabsOn(t *testing.T, f signalFixture) {
	t.Helper()
	prev := testHandler.InboxTabsEmails
	testHandler.InboxTabsEmails = ParseSmartInboxEmails(f.email)
	t.Cleanup(func() { testHandler.InboxTabsEmails = prev })
}

func TestInboxSignalStoresBriefAndMergeFacts(t *testing.T) {
	f := newSignalFixture(t)
	h := signalHandler(testHandler.UpsertInboxSignal)
	var out signalUpsertResponse
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(map[string]any{
		"brief": map[string]any{"situation": " The panel can't start. ", "recommend": "Add the secrets.",
			"default": "", "reply_with": "`done`"},
		"merge": map[string]any{"pr": "#3840", "url": "https://github.com/x/y/pull/3840",
			"review_url": "https://github.com/x/y/pull/3840/files", "risk": "money: services/swap/x.ts",
			"ci": "green", "review": "passed", "lines": 212, "files": 4, "state": "open"},
	}))).Want(http.StatusCreated).JSON(&out)
	var d signalDetails
	if err := json.Unmarshal(out.Item.Details, &d); err != nil {
		t.Fatal(err)
	}
	if d.Brief == nil || d.Brief.Situation != "The panel can't start." || d.Brief.Recommend != "Add the secrets." || d.Brief.DefaultApplies {
		t.Fatalf("brief = %+v", d.Brief)
	}
	if d.Merge == nil || d.Merge.PR != "#3840" || d.Merge.CI != "green" || d.Merge.Lines != 212 || d.Merge.State != "open" {
		t.Fatalf("merge = %+v", d.Merge)
	}

	// An update without them drops them (the feeder sends the whole entry), and stays silent.
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(map[string]any{
		"merge": map[string]any{"pr": "#3840", "state": "merged"},
	}))).Want(http.StatusOK).JSON(&out)
	d = signalDetails{}
	_ = json.Unmarshal(out.Item.Details, &d)
	if out.Pushed || d.Brief != nil || d.Merge == nil || d.Merge.State != "merged" {
		t.Fatalf("update: pushed=%v brief=%+v merge=%+v", out.Pushed, d.Brief, d.Merge)
	}

	// Without either field the stored details have no brief/merge keys at all (old clients see the old shape).
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(map[string]any{
		"key": "needs-human:CTG-2:c2", "brief": map[string]any{"situation": "  "},
	}))).Want(http.StatusCreated).JSON(&out)
	var raw map[string]any
	_ = json.Unmarshal(out.Item.Details, &raw)
	if _, ok := raw["brief"]; ok {
		t.Fatalf("empty brief must be dropped: %v", raw)
	}
	if _, ok := raw["merge"]; ok {
		t.Fatalf("absent merge must stay absent: %v", raw)
	}
}

func TestInboxSignalBriefAndMergeValidation(t *testing.T) {
	f := newSignalFixture(t)
	h := signalHandler(testHandler.UpsertInboxSignal)
	long := make([]byte, 601)
	for i := range long {
		long[i] = 'a'
	}
	for name, over := range map[string]map[string]any{
		"long situation": {"brief": map[string]any{"situation": string(long)}},
		"bad state":      {"merge": map[string]any{"state": "maybe"}},
		"bad ci":         {"merge": map[string]any{"ci": "purple"}},
		"bad url":        {"merge": map[string]any{"url": "javascript:alert(1)"}},
		"negative lines": {"merge": map[string]any{"lines": -1}},
		"bad merged_at":  {"merge": map[string]any{"merged_at": "yesterday"}},
	} {
		t.Run(name, func(t *testing.T) {
			testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(over))).
				Want(http.StatusBadRequest)
		})
	}
}

func TestGetMeReportsInboxTabs(t *testing.T) {
	f := newSignalFixture(t)
	me := func(userID string) UserResponse {
		var out UserResponse
		testutil.Call(t, testHandler.GetMe, testutil.WithHeaders(testutil.JSONRequest(http.MethodGet, "/api/me", nil), "X-User-ID", userID)).
			Want(http.StatusOK).JSON(&out)
		return out
	}
	if me(f.recipientID).InboxTabs {
		t.Fatal("inbox_tabs must be off without MULTICA_INBOX_TABS_EMAILS")
	}
	tabsOn(t, f)
	if !me(f.recipientID).InboxTabs || me(f.botUserID).InboxTabs {
		t.Fatal("inbox_tabs must be on for the listed user only")
	}
	// Tabs need the smart flag too.
	testHandler.SmartInboxEmails = ParseSmartInboxEmails("someone-else@example.com")
	if me(f.recipientID).InboxTabs {
		t.Fatal("inbox_tabs must be off when smart_inbox is off")
	}
}

func TestInboxSquadSnapshotAndLoad(t *testing.T) {
	f := newSignalFixture(t)
	upsert := signalHandler(testHandler.UpsertInboxSignal)
	// Two asks on one card (a re-ask), a merge ask, a finished merge ask, a reminder.
	issue := dbfx.Issue(t, "Squad card", testutil.Cols{"workspace_id": f.workspaceID, "creator_id": f.botUserID})
	dbfx.Cleanup(t, `DELETE FROM issue WHERE id = $1`, issue)
	for _, over := range []map[string]any{
		{"key": "needs-human:CTG-1:a", "group": "decision", "issue_id": issue},
		{"key": "needs-human:CTG-1:b", "group": "decision", "issue_id": issue},
		{"key": "needs-human:CTG-2:c", "group": "merge"},
		{"key": "needs-human:CTG-3:d", "group": "merge", "merge": map[string]any{"state": "merged"}},
		{"key": "reminder:pending", "group": "decision"},
	} {
		testutil.Call(t, upsert, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(over))).Want(http.StatusCreated)
	}

	get := RequireWorkspaceMember(testHandler.GetInboxSquad)
	req := func(userID string) *http.Request {
		return testutil.WithHeaders(testutil.JSONRequest(http.MethodGet, "/api/inbox/squad", nil),
			"X-User-ID", userID, "X-Workspace-ID", f.workspaceID)
	}
	// Flag off: not found.
	testutil.Call(t, get, req(f.recipientID)).Want(http.StatusNotFound)
	tabsOn(t, f)

	var empty struct {
		Snapshot  json.RawMessage `json:"snapshot"`
		InboxLoad []inboxLoadRow  `json:"inbox_load"`
	}
	testutil.Call(t, get, req(f.recipientID)).Want(http.StatusOK).JSON(&empty)
	if string(empty.Snapshot) != "null" {
		t.Fatalf("snapshot before any post = %s", empty.Snapshot)
	}
	var mine *inboxLoadRow
	for i := range empty.InboxLoad {
		if empty.InboxLoad[i].UserID == f.recipientID {
			mine = &empty.InboxLoad[i]
		}
	}
	// The re-ask counts once; the merged merge ask and the reminder are not counted.
	if mine == nil || mine.Decisions != 1 || mine.Merges != 1 || mine.NewAsks7d != 4 {
		t.Fatalf("load = %+v", mine)
	}

	put := signalHandler(testHandler.PutInboxSquad)
	putReq := func(userID string, body any) *http.Request {
		return testutil.WithHeaders(testutil.JSONRequest(http.MethodPut, "/api/inbox/squad", body),
			"X-User-ID", userID, "X-Workspace-ID", f.workspaceID)
	}
	testutil.Call(t, put, putReq(f.recipientID, map[string]any{"x": 1})).Want(http.StatusForbidden)
	testutil.Call(t, put, putReq(f.botUserID, []int{1})).Want(http.StatusBadRequest)
	testutil.Call(t, put, putReq(f.botUserID, map[string]any{"generated_at": "2026-11-12T09:07:00Z"})).Want(http.StatusNoContent)
	var got struct {
		Snapshot   map[string]any `json:"snapshot"`
		ReceivedAt string         `json:"received_at"`
	}
	testutil.Call(t, get, req(f.recipientID)).Want(http.StatusOK).JSON(&got)
	if got.Snapshot["generated_at"] != "2026-11-12T09:07:00Z" || got.ReceivedAt == "" {
		t.Fatalf("squad = %+v", got)
	}
}

// RequireWorkspaceMember mirrors the router's workspace context for a member route.
func RequireWorkspaceMember(h http.HandlerFunc) http.HandlerFunc {
	return middleware.RequireWorkspaceRole(testHandler.Queries, "owner", "admin", "member")(h).ServeHTTP
}
