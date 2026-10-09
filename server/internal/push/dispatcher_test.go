package push

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type fakeStore struct {
	devices  map[string][]Device
	muted    map[string]bool // workspaceID+"/"+userID
	unread   map[string]int
	disabled []string
	owner    string
	agent    string
	lookups  []string // identifier/actor lookups, failing ones included
}

func (s *fakeStore) ListEnabledDevices(_ context.Context, userID string) ([]Device, error) {
	return s.devices[userID], nil
}
func (s *fakeStore) DisableToken(_ context.Context, token string) error {
	s.disabled = append(s.disabled, token)
	return nil
}
func (s *fakeStore) WorkspaceSlug(_ context.Context, wsID string) (string, error) {
	return "slug-" + wsID, nil
}
func (s *fakeStore) SystemNotificationsMuted(_ context.Context, wsID, userID string) (bool, error) {
	return s.muted[wsID+"/"+userID], nil
}
func (s *fakeStore) UnreadInboxCount(_ context.Context, userID string) (int, error) {
	return s.unread[userID], nil
}
func (s *fakeStore) IssueIdentifier(_ context.Context, issueID string) (string, error) {
	s.lookups = append(s.lookups, "issue:"+issueID)
	if issueID == "missing" {
		return "", errors.New("no rows")
	}
	return "MUL-1", nil
}
func (s *fakeStore) ActorName(_ context.Context, actorType, actorID string) (string, error) {
	s.lookups = append(s.lookups, actorType+":"+actorID)
	return "Ana", nil
}
func (s *fakeStore) ChatSessionTarget(context.Context, string) (string, string, error) {
	return s.owner, s.agent, nil
}

type sent struct {
	d Device
	n Notification
}

type fakeSender struct {
	mu   sync.Mutex
	got  []sent
	fail map[string]error
}

func (f *fakeSender) Send(_ context.Context, d Device, n Notification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, sent{d, n})
	return f.fail[d.Token]
}

func newTestDispatcher(store *fakeStore, sender *fakeSender) *Dispatcher {
	return NewDispatcher(store, sender, 8)
}

// drain processes queued jobs synchronously (no workers started).
func drain(d *Dispatcher) {
	for {
		select {
		case j := <-d.queue:
			d.process(context.Background(), j)
		default:
			return
		}
	}
}

func inboxEvent(item any) events.Event {
	return events.Event{Type: protocol.EventInboxNew, WorkspaceID: "ws1", Payload: map[string]any{"item": item}}
}

func memberItem() map[string]any {
	return map[string]any{
		"id": "item1", "workspace_id": "ws1", "recipient_type": "member", "recipient_id": "u1",
		"type": "mentioned", "title": "Fix login", "body": "hey @you",
		"issue_id": "issue1", "details": map[string]any{"comment_id": "c9"},
		"actor_type": "member", "actor_id": "u2",
	}
}

func TestInboxNewPushesToAllRecipientDevices(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}, {Token: "b"}}}, unread: map[string]int{"u1": 4}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(memberItem()))
	drain(d)
	if len(sender.got) != 2 {
		t.Fatalf("sent %d, want 2", len(sender.got))
	}
	n := sender.got[0].n
	if n.Title != "MUL-1 · Ana mentioned you" || n.Subtitle != "Fix login" || n.Body != "hey @you" || n.Badge == nil || *n.Badge != 4 || n.ThreadID != "issue1" {
		t.Fatalf("notification = %+v", n)
	}
	want := map[string]any{"kind": "inbox", "workspace_slug": "slug-ws1", "item_id": "item1", "type": "mentioned", "issue_id": "issue1", "comment_id": "c9"}
	for k, v := range want {
		if n.Data[k] != v {
			t.Fatalf("data[%s] = %v, want %v (data %+v)", k, n.Data[k], v, n.Data)
		}
	}
}

func TestInboxNewStatusChangeUsesDetails(t *testing.T) {
	item := memberItem()
	item["type"] = "status_changed"
	item["body"] = nil
	item["details"] = map[string]any{"from": "todo", "to": "in_review"}
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(item))
	drain(d)
	n := sender.got[0].n
	if n.Title != "MUL-1 · Status → In review" || n.Subtitle != "Fix login" || n.Body != "by Ana" {
		t.Fatalf("notification = %+v", n)
	}
}

func TestInboxNewDegradesWhenLookupsFail(t *testing.T) {
	item := memberItem()
	item["issue_id"] = "missing"
	delete(item, "actor_id")
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(item))
	drain(d)
	n := sender.got[0].n
	if n.Title != "Mentioned" || n.Subtitle != "Fix login" {
		t.Fatalf("notification = %+v", n)
	}
	if len(store.lookups) != 1 {
		t.Fatalf("lookups = %v, want only the issue lookup", store.lookups)
	}
}

func TestInboxNewAcceptsStructPayload(t *testing.T) {
	type itemStruct struct {
		ID            string  `json:"id"`
		WorkspaceID   string  `json:"workspace_id"`
		RecipientType string  `json:"recipient_type"`
		RecipientID   string  `json:"recipient_id"`
		Type          string  `json:"type"`
		Title         string  `json:"title"`
		Body          *string `json:"body"`
	}
	body := "b"
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(itemStruct{ID: "i", WorkspaceID: "ws1", RecipientType: "member", RecipientID: "u1", Type: "x", Title: "t", Body: &body}))
	drain(d)
	if len(sender.got) != 1 {
		t.Fatalf("sent %d", len(sender.got))
	}
}

func TestInboxNewIgnoresAgentRecipients(t *testing.T) {
	item := memberItem()
	item["recipient_type"] = "agent"
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(item))
	drain(d)
	if len(sender.got) != 0 {
		t.Fatalf("sent %d, want 0", len(sender.got))
	}
}

func TestSystemNotificationsMutedSuppressesOnlyThatWorkspace(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}, muted: map[string]bool{"ws1/u1": true}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(memberItem()))
	drain(d)
	if len(sender.got) != 0 {
		t.Fatalf("muted workspace pushed")
	}
	other := memberItem()
	other["workspace_id"] = "ws2"
	d.onInboxNew(events.Event{Type: protocol.EventInboxNew, WorkspaceID: "ws2", Payload: map[string]any{"item": other}})
	drain(d)
	if len(sender.got) != 1 {
		t.Fatalf("other workspace should push, sent %d", len(sender.got))
	}
}

func TestBodyIsTruncated(t *testing.T) {
	item := memberItem()
	long := make([]rune, 300)
	for i := range long {
		long[i] = 'é'
	}
	item["body"] = string(long)
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(item))
	drain(d)
	if got := len([]rune(sender.got[0].n.Body)); got != 180 {
		t.Fatalf("body runes = %d, want 180", got)
	}
}

func TestInvalidTokenIsDisabled(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "dead"}, {Token: "ok"}}}}
	sender := &fakeSender{fail: map[string]error{"dead": ErrTokenInvalid, "ok": nil}}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(memberItem()))
	drain(d)
	if len(store.disabled) != 1 || store.disabled[0] != "dead" {
		t.Fatalf("disabled = %v", store.disabled)
	}
}

func TestOtherSendErrorsKeepToken(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{fail: map[string]error{"a": errors.New("timeout")}}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(memberItem()))
	drain(d)
	if len(store.disabled) != 0 {
		t.Fatalf("disabled = %v", store.disabled)
	}
}

func TestChatDonePushesToSessionOwner(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"owner": {{Token: "a"}}}, owner: "owner", agent: "Largo", unread: map[string]int{"owner": 1}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onChatDone(events.Event{Type: protocol.EventChatDone, WorkspaceID: "ws1", ChatSessionID: "s1",
		Payload: protocol.ChatDonePayload{ChatSessionID: "s1", Content: "Done.\nDetails follow"}})
	drain(d)
	if len(sender.got) != 1 {
		t.Fatalf("sent %d", len(sender.got))
	}
	n := sender.got[0].n
	if n.Title != "Largo" || n.Body != "Done." || n.ThreadID != "s1" || n.Data["kind"] != "chat" || n.Data["session_id"] != "s1" || n.Data["workspace_slug"] != "slug-ws1" {
		t.Fatalf("notification = %+v", n)
	}
}

func TestChatDoneWithoutContentIsIgnored(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"owner": {{Token: "a"}}}, owner: "owner", agent: "A"}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onChatDone(events.Event{Type: protocol.EventChatDone, WorkspaceID: "ws1", Payload: protocol.ChatDonePayload{ChatSessionID: "s1"}})
	drain(d)
	if len(sender.got) != 0 {
		t.Fatalf("sent %d, want 0", len(sender.got))
	}
}

func TestFullQueueDropsWithoutBlocking(t *testing.T) {
	store := &fakeStore{}
	d := NewDispatcher(store, &fakeSender{}, 1)
	d.onInboxNew(inboxEvent(memberItem()))
	d.onInboxNew(inboxEvent(memberItem())) // must return immediately, dropped
	if len(d.queue) != 1 {
		t.Fatalf("queue len = %d", len(d.queue))
	}
}

func TestRegisterSubscribesBothEvents(t *testing.T) {
	bus := events.New()
	NewDispatcher(&fakeStore{}, &fakeSender{}, 1).Register(bus)
	if bus.SubscriberCount(protocol.EventInboxNew) != 1 || bus.SubscriberCount(protocol.EventChatDone) != 1 {
		t.Fatal("dispatcher not subscribed")
	}
}
