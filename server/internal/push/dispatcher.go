package push

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const maxBodyRunes = 180

// Store is the data the dispatcher needs; DBStore implements it.
type Store interface {
	ListEnabledDevices(ctx context.Context, userID string) ([]Device, error)
	DisableToken(ctx context.Context, token string) error
	WorkspaceSlug(ctx context.Context, workspaceID string) (string, error)
	SystemNotificationsMuted(ctx context.Context, workspaceID, userID string) (bool, error)
	UnreadInboxCount(ctx context.Context, userID string) (int, error)
	ChatSessionTarget(ctx context.Context, sessionID string) (ownerID, agentName string, err error)
}

type job struct {
	kind        string // "inbox" | "chat"
	userID      string // chat: resolved in process
	workspaceID string
	title       string
	body        string
	threadID    string
	sessionID   string
	data        map[string]any
}

// Dispatcher turns inbox:new / chat:done bus events into pushes. Bus
// handlers only enqueue; DB lookups and APNs calls run on workers.
type Dispatcher struct {
	store  Store
	sender Sender
	queue  chan job
}

func NewDispatcher(store Store, sender Sender, queueSize int) *Dispatcher {
	return &Dispatcher{store: store, sender: sender, queue: make(chan job, queueSize)}
}

func (d *Dispatcher) Register(bus *events.Bus) {
	bus.Subscribe(protocol.EventInboxNew, d.onInboxNew)
	bus.Subscribe(protocol.EventChatDone, d.onChatDone)
}

// Start runs workers for the process lifetime.
func (d *Dispatcher) Start(workers int) {
	for i := 0; i < workers; i++ {
		go func() {
			for j := range d.queue {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				d.process(ctx, j)
				cancel()
			}
		}()
	}
}

func (d *Dispatcher) enqueue(j job) {
	select {
	case d.queue <- j:
	default:
		slog.Warn("push queue full; dropping notification", "kind", j.kind)
	}
}

// decode re-marshals a payload fragment so map and struct publishers both work.
func decode(v any, out any) bool {
	raw, err := json.Marshal(v)
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, out) == nil
}

func truncate(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= maxBodyRunes {
		return string(r)
	}
	return string(r[:maxBodyRunes-1]) + "…"
}

func (d *Dispatcher) onInboxNew(e events.Event) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		return
	}
	var item struct {
		ID            string  `json:"id"`
		WorkspaceID   string  `json:"workspace_id"`
		RecipientType string  `json:"recipient_type"`
		RecipientID   string  `json:"recipient_id"`
		Type          string  `json:"type"`
		Title         string  `json:"title"`
		Body          *string `json:"body"`
		IssueID       *string `json:"issue_id"`
		Details       struct {
			CommentID string `json:"comment_id"`
		} `json:"details"`
	}
	if !decode(payload["item"], &item) || item.RecipientType != "member" || item.RecipientID == "" {
		return
	}
	wsID := item.WorkspaceID
	if wsID == "" {
		wsID = e.WorkspaceID
	}
	data := map[string]any{"kind": "inbox", "item_id": item.ID, "type": item.Type}
	thread := item.ID
	if item.IssueID != nil && *item.IssueID != "" {
		data["issue_id"] = *item.IssueID
		thread = *item.IssueID
	}
	if item.Details.CommentID != "" {
		data["comment_id"] = item.Details.CommentID
	}
	body := ""
	if item.Body != nil {
		body = *item.Body
	}
	d.enqueue(job{kind: "inbox", userID: item.RecipientID, workspaceID: wsID, title: item.Title,
		body: truncate(body), threadID: thread, data: data})
}

func (d *Dispatcher) onChatDone(e events.Event) {
	var p protocol.ChatDonePayload
	if !decode(e.Payload, &p) {
		return
	}
	first, _, _ := strings.Cut(strings.TrimSpace(p.Content), "\n")
	if first == "" || p.ChatSessionID == "" {
		return
	}
	d.enqueue(job{kind: "chat", workspaceID: e.WorkspaceID, body: truncate(first), threadID: p.ChatSessionID,
		sessionID: p.ChatSessionID, data: map[string]any{"kind": "chat", "session_id": p.ChatSessionID}})
}

func (d *Dispatcher) process(ctx context.Context, j job) {
	if j.kind == "chat" {
		owner, agent, err := d.store.ChatSessionTarget(ctx, j.sessionID)
		if err != nil || owner == "" {
			slog.Warn("push: chat session lookup failed", "session_id", j.sessionID, "error", err)
			return
		}
		j.userID, j.title = owner, agent
	}
	if muted, err := d.store.SystemNotificationsMuted(ctx, j.workspaceID, j.userID); err != nil || muted {
		return
	}
	devices, err := d.store.ListEnabledDevices(ctx, j.userID)
	if err != nil || len(devices) == 0 {
		return
	}
	slug, err := d.store.WorkspaceSlug(ctx, j.workspaceID)
	if err != nil {
		slog.Warn("push: workspace lookup failed", "workspace_id", j.workspaceID, "error", err)
		return
	}
	j.data["workspace_slug"] = slug
	n := Notification{Title: j.title, Body: j.body, ThreadID: j.threadID, Data: j.data}
	if count, err := d.store.UnreadInboxCount(ctx, j.userID); err == nil {
		n.Badge = &count
	}
	for _, dev := range devices {
		err := d.sender.Send(ctx, dev, n)
		switch {
		case err == nil:
		case errors.Is(err, ErrTokenInvalid):
			if derr := d.store.DisableToken(ctx, dev.Token); derr != nil {
				slog.Warn("push: disable token failed", "error", derr)
			}
		default:
			slog.Warn("push: send failed", "kind", j.kind, "error", err)
		}
	}
}
