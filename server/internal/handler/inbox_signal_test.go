package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type signalFixture struct {
	workspaceID string
	botUserID   string
	recipientID string // user id
	memberID    string // recipient's member id
	email       string
}

// newSignalFixture builds a workspace with an admin bot and an enabled
// recipient, and turns the flag on for that recipient for the test.
func newSignalFixture(t *testing.T) signalFixture {
	t.Helper()
	suffix := uuid.NewString()[:8]
	f := signalFixture{email: "signal-" + suffix + "@example.com"}
	f.workspaceID = dbfx.Workspace(t, "Signals "+suffix, "signals-"+suffix)
	f.botUserID = dbfx.User(t, "Bot "+suffix, "bot-"+suffix+"@example.com")
	dbfx.Member(t, f.workspaceID, f.botUserID, "admin")
	f.recipientID = dbfx.User(t, "Recipient "+suffix, f.email)
	f.memberID = dbfx.Member(t, f.workspaceID, f.recipientID, "member")
	dbfx.Cleanup(t, `DELETE FROM inbox_item WHERE workspace_id = $1`, f.workspaceID)
	dbfx.Cleanup(t, `DELETE FROM notification_preference WHERE workspace_id = $1`, f.workspaceID)

	prev := testHandler.SmartInboxEmails
	testHandler.SmartInboxEmails = ParseSmartInboxEmails(" " + strings.ToUpper(f.email) + " ,other@example.com")
	t.Cleanup(func() { testHandler.SmartInboxEmails = prev })
	return f
}

// signalHandler mirrors the router: human actors with an owner/admin role.
func signalHandler(h http.HandlerFunc) http.HandlerFunc {
	return RequireHumanActor(middleware.RequireWorkspaceRole(testHandler.Queries, "owner", "admin")(h)).ServeHTTP
}

func signalRequest(path, userID, workspaceID string, body any) *http.Request {
	return testutil.WithHeaders(
		testutil.JSONRequest(http.MethodPost, path, body),
		"X-User-ID", userID,
		"X-Workspace-ID", workspaceID,
	)
}

func (f signalFixture) body(over map[string]any) map[string]any {
	b := map[string]any{
		"recipient_member_id": f.recipientID,
		"key":                 "needs-human:CTG-1:c1",
		"group":               "merge",
		"severity":            "action_required",
		"title":               "Approve merge #3204",
		"summary":             "CTG-1 · blocks 3 cards · waiting 6 h",
		"body":                "Short context.",
		"actions":             []map[string]any{{"label": "Open PR", "url": "https://github.com/x/y/pull/1"}},
		"rank":                map[string]any{"priority": "high", "blocks": 3, "since": "2026-11-01T10:00:00Z"},
		"push":                true,
	}
	for k, v := range over {
		b[k] = v
	}
	return b
}

type signalUpsertResponse struct {
	Item    InboxItemResponse `json:"item"`
	Created bool              `json:"created"`
	Pushed  bool              `json:"pushed"`
}

// inboxEventRecorder counts inbox:new / inbox:updated / inbox:archived events
// for one recipient. The bus is synchronous.
type inboxEventRecorder struct {
	mu     sync.Mutex
	counts map[string]int
}

func recordInboxEvents(t *testing.T, recipientID string) *inboxEventRecorder {
	rec := &inboxEventRecorder{counts: map[string]int{}}
	listener := func(e events.Event) {
		p, ok := e.Payload.(map[string]any)
		if !ok {
			return
		}
		rid, _ := p["recipient_id"].(string)
		if item, ok := p["item"].(map[string]any); ok && rid == "" {
			rid, _ = item["recipient_id"].(string)
		}
		if rid != recipientID {
			return
		}
		rec.mu.Lock()
		rec.counts[e.Type]++
		rec.mu.Unlock()
	}
	for _, typ := range []string{protocol.EventInboxNew, protocol.EventInboxUpdated, protocol.EventInboxArchived} {
		testHandler.Bus.Subscribe(typ, listener)
	}
	return rec
}

func (r *inboxEventRecorder) get(typ string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.counts[typ]
}

func TestInboxSignalUpsertUpdateResolve(t *testing.T) {
	f := newSignalFixture(t)
	rec := recordInboxEvents(t, f.recipientID)
	h := signalHandler(testHandler.UpsertInboxSignal)

	var created signalUpsertResponse
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(nil))).
		Want(http.StatusCreated).JSON(&created)
	if !created.Created || !created.Pushed || created.Item.Type != "signal" || created.Item.RecipientID != f.recipientID {
		t.Fatalf("create response = %+v", created)
	}
	if created.Item.ActorType == nil || *created.Item.ActorType != "system" || created.Item.ActorID != nil {
		t.Fatalf("signal actor = %v/%v, want system with no id", created.Item.ActorType, created.Item.ActorID)
	}
	var details signalDetails
	if err := json.Unmarshal(created.Item.Details, &details); err != nil {
		t.Fatal(err)
	}
	if details.Key != "needs-human:CTG-1:c1" || details.Group != "merge" || details.Summary == "" ||
		len(details.Actions) != 1 || details.Rank.Priority != "high" || details.Rank.Blocks != 3 || details.Rank.Since != "2026-11-01T10:00:00Z" {
		t.Fatalf("details = %+v", details)
	}
	if rec.get(protocol.EventInboxNew) != 1 {
		t.Fatalf("inbox:new after create = %d, want 1", rec.get(protocol.EventInboxNew))
	}

	// Same title and summary with push:true: in-place update, no push.
	var same signalUpsertResponse
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID,
		f.body(map[string]any{"body": "New context.", "rank": map[string]any{"priority": "urgent", "blocks": 5}}))).
		Want(http.StatusOK).JSON(&same)
	if same.Created || same.Pushed || same.Item.ID != created.Item.ID {
		t.Fatalf("same-text update = %+v", same)
	}
	_ = json.Unmarshal(same.Item.Details, &details)
	if details.Rank.Since != "2026-11-01T10:00:00Z" || details.Rank.Priority != "urgent" {
		t.Fatalf("update must keep rank.since when omitted: %+v", details.Rank)
	}
	if rec.get(protocol.EventInboxNew) != 1 || rec.get(protocol.EventInboxUpdated) != 1 {
		t.Fatalf("events after silent update = %+v", rec.counts)
	}

	// Changed summary without push: silent.
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID,
		f.body(map[string]any{"summary": "waiting 7 h", "push": false}))).Want(http.StatusOK).JSON(&same)
	if same.Pushed {
		t.Fatal("update without push:true must not push")
	}

	// The user reads and archives it; a re-raise brings it back unread.
	dbfx.Exec(t, `UPDATE inbox_item SET read = true, archived = true WHERE id = $1`, created.Item.ID)
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID,
		f.body(map[string]any{"summary": "waiting 8 h"}))).Want(http.StatusOK).JSON(&same)
	if !same.Pushed || same.Item.ID != created.Item.ID || same.Item.Read || same.Item.Archived {
		t.Fatalf("re-raise = %+v", same)
	}
	if rec.get(protocol.EventInboxNew) != 2 {
		t.Fatalf("inbox:new after re-raise = %d, want 2", rec.get(protocol.EventInboxNew))
	}

	// Resolve archives without a push; a second resolve is a 204.
	resolve := signalHandler(testHandler.ResolveInboxSignal)
	resolveBody := map[string]any{"recipient_member_id": f.recipientID, "key": "needs-human:CTG-1:c1"}
	testutil.Call(t, resolve, signalRequest("/api/inbox/signals/resolve", f.botUserID, f.workspaceID, resolveBody)).
		Want(http.StatusOK)
	if got := dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE id = $1 AND archived AND details ? 'resolved_at'`, created.Item.ID); got != 1 {
		t.Fatalf("resolved rows = %d, want 1", got)
	}
	if rec.get(protocol.EventInboxNew) != 2 || rec.get(protocol.EventInboxArchived) != 1 {
		t.Fatalf("events after resolve = %+v", rec.counts)
	}
	testutil.Call(t, resolve, signalRequest("/api/inbox/signals/resolve", f.botUserID, f.workspaceID, resolveBody)).
		Want(http.StatusNoContent)

	// The key is free again: the next raise is a new item.
	var again signalUpsertResponse
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(nil))).
		Want(http.StatusCreated).JSON(&again)
	if again.Item.ID == created.Item.ID {
		t.Fatal("raise after resolve must create a new item")
	}
}

// Rows raised before signals carried a system actor heal on their next update.
func TestInboxSignalUpdateSetsSystemActor(t *testing.T) {
	f := newSignalFixture(t)
	dbfx.Insert(t, "inbox_item", testutil.Cols{
		"workspace_id": f.workspaceID, "recipient_type": "member", "recipient_id": f.recipientID,
		"type": "signal", "severity": "attention", "title": "Old",
		"details": `{"key":"needs-human:CTG-1:c1","group":"merge","summary":"s","actions":[],"rank":{"priority":"none","blocks":0,"since":"2026-11-01T10:00:00Z"}}`,
	})
	var out signalUpsertResponse
	testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
		signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(map[string]any{"push": false}))).
		Want(http.StatusOK).JSON(&out)
	if out.Item.ActorType == nil || *out.Item.ActorType != "system" {
		t.Fatalf("actor_type = %v, want system", out.Item.ActorType)
	}
}

func TestInboxSignalAcceptsMemberRowID(t *testing.T) {
	f := newSignalFixture(t)
	var out signalUpsertResponse
	testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
		signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(map[string]any{"recipient_member_id": f.memberID}))).
		Want(http.StatusCreated).JSON(&out)
	if out.Item.RecipientID != f.recipientID {
		t.Fatalf("recipient_id = %s, want user %s", out.Item.RecipientID, f.recipientID)
	}
}

// The feeder authenticates with the bot's personal access token. Run the
// real Auth middleware in front of the route's guards.
func TestInboxSignalBotPATPassesAuth(t *testing.T) {
	f := newSignalFixture(t)
	raw := "mul_signal_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	dbfx.Insert(t, "personal_access_token", testutil.Cols{
		"user_id": f.botUserID, "name": "feeder", "token_hash": auth.HashToken(raw), "token_prefix": raw[:12],
	})
	chain := middleware.Auth(testHandler.Queries, nil, nil, nil)(
		RequireHumanActor(middleware.RequireWorkspaceRole(testHandler.Queries, "owner", "admin")(
			http.HandlerFunc(testHandler.UpsertInboxSignal))))
	req := testutil.WithHeaders(testutil.JSONRequest(http.MethodPost, "/api/inbox/signals", f.body(nil)),
		"Authorization", "Bearer "+raw, "X-Workspace-ID", f.workspaceID)
	testutil.Call(t, chain.ServeHTTP, req).Want(http.StatusCreated)
}

func TestInboxSignalFlagOffIsNoop(t *testing.T) {
	f := newSignalFixture(t)
	testHandler.SmartInboxEmails = ParseSmartInboxEmails("someone-else@example.com")
	rec := recordInboxEvents(t, f.recipientID)
	testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
		signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(nil))).Want(http.StatusNoContent)
	testutil.Call(t, signalHandler(testHandler.ResolveInboxSignal),
		signalRequest("/api/inbox/signals/resolve", f.botUserID, f.workspaceID,
			map[string]any{"recipient_member_id": f.recipientID, "key": "needs-human:CTG-1:c1"})).Want(http.StatusNoContent)
	if n := dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE workspace_id = $1`, f.workspaceID); n != 0 {
		t.Fatalf("inbox rows = %d, want 0", n)
	}
	if len(rec.counts) != 0 {
		t.Fatalf("events = %+v, want none", rec.counts)
	}
}

func TestInboxSignalValidation(t *testing.T) {
	f := newSignalFixture(t)
	outsider := dbfx.User(t, "Outsider", "outsider-"+uuid.NewString()[:8]+"@example.com")
	otherWS := dbfx.Workspace(t, "Other", "other-"+uuid.NewString()[:8])
	foreignIssue := dbfx.Issue(t, "Foreign", testutil.Cols{"workspace_id": otherWS})
	cases := map[string]map[string]any{
		"bad group":          {"group": "spam"},
		"bad severity":       {"severity": "loud"},
		"missing key":        {"key": " "},
		"long title":         {"title": strings.Repeat("x", 61)},
		"long summary":       {"summary": strings.Repeat("x", 141)},
		"long body":          {"body": strings.Repeat("x", 601)},
		"javascript url":     {"actions": []map[string]any{{"label": "x", "url": "javascript:alert(1)"}}},
		"relative url":       {"actions": []map[string]any{{"label": "x", "url": "/issues/1"}}},
		"empty label":        {"actions": []map[string]any{{"label": "", "url": "https://a.b"}}},
		"too many actions":   {"actions": []map[string]any{{"label": "a", "url": "https://a.b"}, {"label": "b", "url": "https://a.b"}, {"label": "c", "url": "https://a.b"}, {"label": "d", "url": "https://a.b"}}},
		"bad priority":       {"rank": map[string]any{"priority": "p0"}},
		"negative blocks":    {"rank": map[string]any{"blocks": -1}},
		"bad since":          {"rank": map[string]any{"since": "yesterday"}},
		"non-member":         {"recipient_member_id": outsider},
		"bad recipient uuid": {"recipient_member_id": "nope"},
		"foreign issue":      {"issue_id": foreignIssue},
	}
	for name, over := range cases {
		t.Run(name, func(t *testing.T) {
			testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
				signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(over))).Want(http.StatusBadRequest)
		})
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE workspace_id = $1`, f.workspaceID); n != 0 {
		t.Fatalf("inbox rows = %d, want 0", n)
	}
}

func TestInboxSignalAuth(t *testing.T) {
	f := newSignalFixture(t)
	// A plain member may not raise signals.
	testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
		signalRequest("/api/inbox/signals", f.recipientID, f.workspaceID, f.body(nil))).Want(http.StatusForbidden)
	// An agent's task token is refused even when its owner is an admin.
	req := signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID, f.body(nil))
	req.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal), req).Want(http.StatusForbidden)
	// The workspace owner may.
	owner := dbfx.User(t, "Owner", "owner-"+uuid.NewString()[:8]+"@example.com")
	dbfx.Member(t, f.workspaceID, owner, "owner")
	testutil.Call(t, signalHandler(testHandler.UpsertInboxSignal),
		signalRequest("/api/inbox/signals", owner, f.workspaceID, f.body(nil))).Want(http.StatusCreated)
}

func TestInboxSignalPushRespectsGroupPreferences(t *testing.T) {
	f := newSignalFixture(t)
	h := signalHandler(testHandler.UpsertInboxSignal)
	raise := func(key, group string) signalUpsertResponse {
		var out signalUpsertResponse
		testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID,
			f.body(map[string]any{"key": key, "group": group}))).Want(http.StatusCreated).JSON(&out)
		return out
	}
	if !raise("a", "merge").Pushed {
		t.Fatal("merge pushes by default")
	}
	if raise("b", "fyi").Pushed {
		t.Fatal("fyi does not push by default")
	}
	dbfx.Exec(t, `INSERT INTO notification_preference (workspace_id, user_id, preferences)
		VALUES ($1, $2, '{"signal_merge":"muted","signal_fyi":"all"}')`, f.workspaceID, f.recipientID)
	if raise("c", "merge").Pushed {
		t.Fatal("muted merge must not push")
	}
	if !raise("d", "fyi").Pushed {
		t.Fatal("fyi set to all must push")
	}
	// Created signals stay in the inbox either way.
	if n := dbfx.Count(t, `SELECT count(*) FROM inbox_item WHERE workspace_id = $1 AND type = 'signal'`, f.workspaceID); n != 4 {
		t.Fatalf("signals = %d, want 4", n)
	}
	// create with push:false is silent
	var out signalUpsertResponse
	testutil.Call(t, h, signalRequest("/api/inbox/signals", f.botUserID, f.workspaceID,
		f.body(map[string]any{"key": "e", "push": false}))).Want(http.StatusCreated).JSON(&out)
	if out.Pushed {
		t.Fatal("push:false create must not push")
	}
}

func TestGetMeReportsSmartInbox(t *testing.T) {
	f := newSignalFixture(t)
	var me UserResponse
	testutil.Call(t, testHandler.GetMe, testutil.WithHeaders(testutil.JSONRequest(http.MethodGet, "/api/me", nil), "X-User-ID", f.recipientID)).
		Want(http.StatusOK).JSON(&me)
	if !me.SmartInbox {
		t.Fatal("smart_inbox should be true for an allowlisted user")
	}
	var other UserResponse
	testutil.Call(t, testHandler.GetMe, testutil.WithHeaders(testutil.JSONRequest(http.MethodGet, "/api/me", nil), "X-User-ID", f.botUserID)).
		Want(http.StatusOK).JSON(&other)
	if other.SmartInbox {
		t.Fatal("smart_inbox should be false for other users")
	}
}

func TestSignalPushPreferenceKeysAreAccepted(t *testing.T) {
	for _, g := range []string{"merge", "decision", "access", "stalled", "blocking", "alert", "fyi"} {
		if !validNotifGroups[signalPushPrefKey(g)] || !signalGroups[g] {
			t.Fatalf("group %s missing from preference keys", g)
		}
	}
}
