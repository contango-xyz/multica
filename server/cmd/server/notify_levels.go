package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/notiflevel"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// levelStore is what the desktop-banner gate reads (push.DBStore implements it).
type levelStore interface {
	NotificationPrefs(ctx context.Context, workspaceID, userID string) (map[string]string, error)
	IssueLabels(ctx context.Context, workspaceID, issueID string) ([]string, error)
}

// desktopNotifyGate answers, for a new inbox item, whether its recipient's desktop/web banner may show
// (notification levels, contango patch 39). Any lookup failure shows it: a hiccup never silences someone.
func desktopNotifyGate(store levelStore) func(workspaceID, recipientID string, item map[string]any) bool {
	return func(workspaceID, recipientID string, item map[string]any) bool {
		if ws, _ := item["workspace_id"].(string); ws != "" {
			workspaceID = ws
		}
		if workspaceID == "" || recipientID == "" {
			return true
		}
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		prefs, err := store.NotificationPrefs(ctx, workspaceID, recipientID)
		if err != nil {
			slog.Warn("notify levels: preferences lookup failed", "error", err)
			return true
		}
		if len(prefs) == 0 {
			return true
		}
		var labels []string
		if issueID, _ := item["issue_id"].(string); issueID != "" {
			labels, _ = store.IssueLabels(ctx, workspaceID, issueID)
		}
		typ, _ := item["type"].(string)
		group := ""
		if details, ok := item["details"].(map[string]any); ok {
			group, _ = details["group"].(string)
		}
		category := notiflevel.CategoryOf(typ, group, labels)
		return notiflevel.Allowed(prefs, category, notiflevel.Desktop, workspaceID, recipientID, time.Now())
	}
}

// timeOffLister is the availability query the "away" check reads (patch 38's member_time_off).
type timeOffLister interface {
	ListMemberTimeOff(ctx context.Context, arg db.ListMemberTimeOffParams) ([]db.MemberTimeOff, error)
}

// awayFromTimeOff answers whether the person has time off today (UTC date), for quiet hours: on a day off only
// Critical pushes. A failed lookup counts as at work, so nothing is silenced by a hiccup.
func awayFromTimeOff(q timeOffLister) func(workspaceID, userID string, now time.Time) bool {
	return func(workspaceID, userID string, now time.Time) bool {
		wid, err1 := util.ParseUUID(workspaceID)
		uid, err2 := util.ParseUUID(userID)
		if err1 != nil || err2 != nil {
			return false
		}
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		day := pgtype.Date{Time: time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC), Valid: true}
		rows, err := q.ListMemberTimeOff(ctx, db.ListMemberTimeOffParams{WorkspaceID: wid, FromDay: day, ToDay: day})
		if err != nil {
			slog.Warn("notify levels: time-off lookup failed", "error", err)
			return false
		}
		for _, r := range rows {
			if r.UserID == uid {
				return true
			}
		}
		return false
	}
}
