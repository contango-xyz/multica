package service

// Contango patch 40: squad agents may manage a wakeup on their own card.
//
// A wakeup is managed by its creator or a workspace admin. Squad agents act for
// whichever human started their run, so without this a wakeup another principal
// registered (the bot, or a teammate acting for a different human) is out of
// their reach. When the request comes from an agent's own run, these also allow
// it, on that issue only:
//
//   - the agent registered the wakeup (it owns the run in source_task_id);
//   - the issue is assigned to a squad the agent leads or belongs to;
//   - the human the agent acts for is the issue's "Responsible human".
//
// Humans other than the creator and admins are unchanged.

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ResponsibleHumanProperty is the actor property naming a card's responsible
// human (matched by name, case-insensitively, per workspace).
const ResponsibleHumanProperty = "responsible human"

// mayManageWakeup reports whether member (the human a request acts for, with
// role in the issue's workspace) may manage w. s.ActingAgent is the calling
// agent, set only for a trusted agent run.
func (s *IssueWakeupService) mayManageWakeup(ctx context.Context, q db.DBTX, w db.IssueWakeup, member pgtype.UUID, role string) (bool, error) {
	if w.CreatedBy == member || role == "owner" || role == "admin" {
		return true, nil
	}
	if !s.ActingAgent.Valid {
		return false, nil
	}
	var ok bool
	err := q.QueryRow(ctx, `SELECT
  EXISTS(SELECT 1 FROM agent_task_queue t WHERE t.id=$2 AND t.agent_id=$3)
  OR EXISTS(SELECT 1 FROM issue i JOIN squad s ON s.id=i.assignee_id AND s.workspace_id=i.workspace_id AND s.archived_at IS NULL
    WHERE i.id=$1 AND i.assignee_type='squad'
      AND (s.leader_id=$3 OR EXISTS(SELECT 1 FROM squad_member sm WHERE sm.squad_id=s.id AND sm.member_type='agent' AND sm.member_id=$3)))
  OR EXISTS(SELECT 1 FROM issue i JOIN issue_property p ON p.workspace_id=i.workspace_id AND p.archived_at IS NULL AND p.type='actor' AND lower(p.name)=$5
    WHERE i.id=$1 AND i.properties->>(p.id::text) = 'member:'||$4::text)`,
		w.IssueID, w.SourceTaskID, s.ActingAgent, member, ResponsibleHumanProperty).Scan(&ok)
	return ok, err
}
