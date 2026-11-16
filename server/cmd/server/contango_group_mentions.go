package main

// Contango patch 48: @group mentions (role mention groups, internal/membergroup).

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/membergroup"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// viaGroupRef is what a group-expanded inbox item records in details.via_group.
type viaGroupRef struct {
	ID     string `json:"id"`
	Handle string `json:"handle"`
}

// An agent may mention a group (that is the point: "ask @devops"), but not flood
// it, as patch 41's 28-card @all did: the same non-member author mentioning the
// same group on more than groupMentionBurstMax distinct cards within
// groupMentionBurstWindow notifies nobody for the extra cards. The comment stays.
const (
	groupMentionBurstMax    = 5
	groupMentionBurstWindow = 10 * time.Minute
)

type groupMentionGuard struct {
	mu   sync.Mutex
	seen map[string]map[string]time.Time // actor|group -> issue -> last mention
}

var groupMentionFlood = &groupMentionGuard{seen: map[string]map[string]time.Time{}}

// allow records the mention and says whether it may notify.
func (g *groupMentionGuard) allow(actorID, groupID, issueID string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	key := actorID + "|" + groupID
	issues := g.seen[key]
	if issues == nil {
		issues = map[string]time.Time{}
		g.seen[key] = issues
	}
	for id, at := range issues {
		if now.Sub(at) > groupMentionBurstWindow {
			delete(issues, id)
		}
	}
	if _, again := issues[issueID]; !again && len(issues) >= groupMentionBurstMax {
		return false
	}
	issues[issueID] = now
	return true
}

// expandGroupMentions adds each mentioned group's people on duty to recipients
// and returns, for each person reached only through a group, which group.
func expandGroupMentions(queries *db.Queries, e events.Event, issueID string, groupIDs []string, recipients map[string]bool) map[string]viaGroupRef {
	via := map[string]viaGroupRef{}
	if len(groupIDs) == 0 {
		return via
	}
	wsID, err := util.ParseUUID(e.WorkspaceID)
	if err != nil {
		return via
	}
	groups, err := membergroup.Load(context.Background(), queries, wsID, time.Now())
	if err != nil {
		slog.Error("failed to load groups for @group mention", "workspace_id", e.WorkspaceID, "error", err)
		return via
	}
	for _, gid := range groupIDs {
		g, ok := membergroup.Find(groups, gid)
		if !ok || g.ID != gid {
			continue // unknown or archived group: the mention shows as text
		}
		if e.ActorType != "member" && !groupMentionFlood.allow(e.ActorID, gid, issueID, time.Now()) {
			slog.Warn("dropping @group mention: same author, same group, too many cards",
				"actor_type", e.ActorType, "actor_id", e.ActorID, "group", g.Handle,
				"workspace_id", e.WorkspaceID, "issue_id", issueID)
			continue
		}
		for _, uid := range g.OnDuty {
			if recipients[uid] {
				continue
			}
			recipients[uid] = true
			via[uid] = viaGroupRef{ID: g.ID, Handle: g.Handle}
		}
	}
	return via
}

// withViaGroup adds details.via_group to an item reached through a group.
func withViaGroup(details []byte, ref viaGroupRef) []byte {
	if ref.ID == "" {
		return details
	}
	m := map[string]any{}
	if len(details) > 0 {
		if err := json.Unmarshal(details, &m); err != nil {
			return details
		}
	}
	m["via_group"] = ref
	out, err := json.Marshal(m)
	if err != nil {
		return details
	}
	return out
}
