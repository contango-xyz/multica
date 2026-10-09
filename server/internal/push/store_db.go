package push

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// DBStore reads push data through sqlc queries.
type DBStore struct{ q *db.Queries }

func NewDBStore(q *db.Queries) *DBStore { return &DBStore{q: q} }

func (s *DBStore) ListEnabledDevices(ctx context.Context, userID string) ([]Device, error) {
	uid, err := util.ParseUUID(userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListEnabledPushDevicesByUser(ctx, uid)
	if err != nil {
		return nil, err
	}
	out := make([]Device, 0, len(rows))
	for _, r := range rows {
		out = append(out, Device{Token: r.Token, BundleID: r.BundleID, Environment: r.Environment})
	}
	return out, nil
}

func (s *DBStore) DisableToken(ctx context.Context, token string) error {
	return s.q.DisablePushDeviceByToken(ctx, token)
}

func (s *DBStore) WorkspaceSlug(ctx context.Context, workspaceID string) (string, error) {
	id, err := util.ParseUUID(workspaceID)
	if err != nil {
		return "", err
	}
	ws, err := s.q.GetWorkspace(ctx, id)
	if err != nil {
		return "", err
	}
	return ws.Slug, nil
}

// SystemNotificationsMuted mirrors desktop: the per-workspace
// "system_notifications" preference gates every OS-level notification.
func (s *DBStore) SystemNotificationsMuted(ctx context.Context, workspaceID, userID string) (bool, error) {
	wid, err := util.ParseUUID(workspaceID)
	if err != nil {
		return false, err
	}
	uid, err := util.ParseUUID(userID)
	if err != nil {
		return false, err
	}
	pref, err := s.q.GetNotificationPreference(ctx, db.GetNotificationPreferenceParams{WorkspaceID: wid, UserID: uid})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var prefs map[string]string
	if json.Unmarshal(pref.Preferences, &prefs) != nil {
		return false, nil
	}
	return prefs["system_notifications"] == "muted", nil
}

// UnreadInboxCount sums the same per-workspace unread counts the inbox
// badge uses (GET /api/inbox/unread-summary).
func (s *DBStore) UnreadInboxCount(ctx context.Context, userID string) (int, error) {
	uid, err := util.ParseUUID(userID)
	if err != nil {
		return 0, err
	}
	rows, err := s.q.CountUnreadInboxByWorkspace(ctx, uid)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, r := range rows {
		total += int(r.Count)
	}
	return total, nil
}

// ChatSessionTarget returns the chat's owner and agent name; an empty owner
// with a nil error means the chat must not be pushed.
func (s *DBStore) ChatSessionTarget(ctx context.Context, sessionID string) (string, string, error) {
	sid, err := util.ParseUUID(sessionID)
	if err != nil {
		return "", "", err
	}
	// Chats driven from Slack/Lark/Telegram/... already deliver the reply in
	// that app; pushing it to the phone too would double every message.
	if _, err := s.q.GetChannelChatSessionBindingBySessionAny(ctx, sid); err == nil {
		return "", "", nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	sess, err := s.q.GetChatSession(ctx, sid)
	if err != nil {
		return "", "", err
	}
	name := "Agent"
	if agent, err := s.q.GetAgent(ctx, sess.AgentID); err == nil && agent.Name != "" {
		name = agent.Name
	}
	return util.UUIDToString(sess.CreatorID), name, nil
}

// IssueIdentifier returns the human key, e.g. "CTG-823".
func (s *DBStore) IssueIdentifier(ctx context.Context, issueID string) (string, error) {
	id, err := util.ParseUUID(issueID)
	if err != nil {
		return "", err
	}
	issue, err := s.q.GetIssue(ctx, id)
	if err != nil {
		return "", err
	}
	ws, err := s.q.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%d", ws.IssuePrefix, issue.Number), nil
}

// ActorName resolves an inbox item's actor: members by user id, agents by
// agent id. Other actor types (e.g. system) have no name.
func (s *DBStore) ActorName(ctx context.Context, actorType, actorID string) (string, error) {
	id, err := util.ParseUUID(actorID)
	if err != nil {
		return "", err
	}
	switch actorType {
	case "member":
		u, err := s.q.GetUser(ctx, id)
		return u.Name, err
	case "agent":
		a, err := s.q.GetAgent(ctx, id)
		return a.Name, err
	}
	return "", nil
}
