package handler

// Inbox tabs (contango patch 43, owner 2026-11-12; docs/contango/SMART-INBOX.md
// "Tabs"). The smart inbox as five tabs: Today, Decisions, Merges, Squad and
// Everything else. Behind its own flag, MULTICA_INBOX_TABS_EMAILS (owner only
// at first); /api/me says `inbox_tabs: true` for users on it.
//
// The Squad tab reads a snapshot the ops feeder posts every run (PUT
// /api/inbox/squad, workspace owner/admin, human credentials: the bot PAT),
// kept in memory per workspace: after a restart the tab says "no data yet" until
// the feeder's next pass (2 minutes). GET /api/inbox/squad adds the inbox load
// per person, counted here from inbox_item.

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/logger"
)

const squadSnapshotMaxBytes = 256 << 10

func inboxTabsEmailsFromEnv() map[string]bool {
	return ParseSmartInboxEmails(os.Getenv("MULTICA_INBOX_TABS_EMAILS"))
}

// InboxTabsEnabledFor reports whether the tabbed inbox is on for this email.
// Tabs are a smart-inbox view, so the smart flag is required too.
func (h *Handler) InboxTabsEnabledFor(email string) bool {
	e := strings.ToLower(strings.TrimSpace(email))
	return h.InboxTabsEmails[e] && h.SmartInboxEmails[e]
}

type squadSnapshot struct {
	Data       json.RawMessage
	ReceivedAt time.Time
}

// squadSnapshots holds the latest snapshot per workspace id.
var squadSnapshots sync.Map

// PutInboxSquad handles PUT /api/inbox/squad: store the feeder's snapshot (any
// JSON object up to 256 KiB) for this workspace.
func (h *Handler) PutInboxSquad(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, squadSnapshotMaxBytes)).Decode(&raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		writeError(w, http.StatusBadRequest, "snapshot must be a JSON object")
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	if _, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id"); !ok {
		return
	}
	squadSnapshots.Store(workspaceID, squadSnapshot{Data: raw, ReceivedAt: time.Now().UTC()})
	w.WriteHeader(http.StatusNoContent)
}

// inboxLoadRow is one person's open inbox, counted in cards (a card with
// several entries counts once per tab), plus the asks raised for them in the
// last 7 days (every decision and merge entry, re-asks included).
type inboxLoadRow struct {
	UserID    string `json:"user_id"`
	Name      string `json:"name"`
	Decisions int    `json:"decisions"`
	Merges    int    `json:"merges"`
	Else      int    `json:"everything_else"`
	NewAsks7d int    `json:"new_asks_7d"`
}

// The tab rules of packages/core/inbox/smart-tabs.ts, in SQL: digest and
// reminder entries are left out, merge asks that are finished (details.merge.state
// other than open) are hidden, and a card counts once per tab.
const inboxLoadSQL = `
WITH live AS (
  SELECT x.recipient_id, x.type, x.issue_id, x.id, x.created_at, x.archived,
         x.details->>'group' AS grp, coalesce(x.details->>'key', '') AS skey,
         coalesce(x.details->'merge'->>'state', 'open') AS mstate
  FROM inbox_item x
  WHERE x.workspace_id = $1 AND x.recipient_type = 'member'
    AND (NOT x.archived OR x.created_at > now() - interval '7 days')
)
SELECT u.id::text, u.name,
  count(DISTINCT coalesce(l.issue_id, l.id)) FILTER (WHERE NOT l.archived AND l.type = 'signal'
    AND l.grp IN ('decision', 'access', 'blocking') AND l.skey NOT LIKE 'digest:%' AND l.skey NOT LIKE 'reminder:%'),
  count(DISTINCT coalesce(l.issue_id, l.id)) FILTER (WHERE NOT l.archived AND l.type = 'signal'
    AND l.grp = 'merge' AND l.mstate = 'open'),
  count(DISTINCT coalesce(l.issue_id, l.id)) FILTER (WHERE NOT l.archived AND (l.type <> 'signal'
    OR l.grp IN ('fyi', 'stalled', 'alert'))),
  count(*) FILTER (WHERE l.type = 'signal' AND l.grp IN ('decision', 'access', 'blocking', 'merge')
    AND l.skey NOT LIKE 'digest:%' AND l.skey NOT LIKE 'reminder:%' AND l.created_at > now() - interval '7 days')
FROM member m
JOIN "user" u ON u.id = m.user_id
LEFT JOIN live l ON l.recipient_id = m.user_id
WHERE m.workspace_id = $1
GROUP BY u.id, u.name`

// GetInboxSquad handles GET /api/inbox/squad for users on the tabs flag:
// {snapshot, received_at, inbox_load}. snapshot is null until the feeder posts.
func (h *Handler) GetInboxSquad(w http.ResponseWriter, r *http.Request) {
	userID := requestUserID(r)
	user, err := h.Queries.GetUser(r.Context(), parseUUID(userID))
	if err != nil || !h.InboxTabsEnabledFor(user.Email) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	resp := map[string]any{"snapshot": nil, "received_at": nil, "inbox_load": []inboxLoadRow{}}
	if v, ok := squadSnapshots.Load(workspaceID); ok {
		s := v.(squadSnapshot)
		resp["snapshot"] = s.Data
		resp["received_at"] = s.ReceivedAt.Format(time.RFC3339)
	}
	rows, err := h.DB.Query(r.Context(), inboxLoadSQL, wsUUID)
	if err != nil {
		slog.Warn("inbox squad: load query failed", append(logger.RequestAttrs(r), "error", err)...)
		writeJSON(w, http.StatusOK, resp)
		return
	}
	defer rows.Close()
	load := []inboxLoadRow{}
	for rows.Next() {
		var row inboxLoadRow
		if err := rows.Scan(&row.UserID, &row.Name, &row.Decisions, &row.Merges, &row.Else, &row.NewAsks7d); err != nil {
			slog.Warn("inbox squad: load scan failed", append(logger.RequestAttrs(r), "error", err)...)
			break
		}
		if row.Decisions+row.Merges+row.Else+row.NewAsks7d > 0 {
			load = append(load, row)
		}
	}
	resp["inbox_load"] = load
	writeJSON(w, http.StatusOK, resp)
}
