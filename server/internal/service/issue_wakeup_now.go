package service

// "Wake this agent now" (contango patch 27, docs/contango/PATCHES.md): one run
// with an instruction and no timer. It saves a one-shot rule and fires it at
// once, so the run gets everything a fired rule's run gets (its pending slot,
// the [WAKEUP] prompt, joining a waiting run, cancel on close, the claim
// check). The rule is hidden from every list and swept once finished.

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	// HiddenWakeupRetention is how long a finished hidden rule stays, so a
	// run's context can still be traced to it.
	HiddenWakeupRetention = 7 * 24 * time.Hour
	hiddenWakeupSweepRows = 500

	WakeupNowQueued = "queued"
	// WakeupNowPending means no run of its own yet: the input waits for a run
	// of the agent that is about to start, or for the scheduler's next pass.
	WakeupNowPending = "pending"
)

type WakeupNowInput struct {
	AgentID         string `json:"agent_id"`
	Instruction     string `json:"instruction"`
	ParentCommentID string `json:"parent_comment_id"`
}

type WakeupNowResult struct {
	WakeupID string `json:"wakeup_id"`
	TaskID   string `json:"task_id,omitempty"`
	Outcome  string `json:"outcome"`
}

// Now saves the hidden rule under Save's checks and dispatches it. Once the
// rule is committed the request has succeeded: the scheduler retries a
// dispatch that fails here, as it does for any due rule.
func (s *IssueWakeupService) Now(ctx context.Context, issueID, member, source pgtype.UUID, in WakeupNowInput) (WakeupNowResult, error) {
	rule, err := s.Save(ctx, issueID, member, source, pgtype.UUID{}, WakeupInput{
		AgentID: in.AgentID, Instruction: in.Instruction, ParentCommentID: in.ParentCommentID,
		Kind: "at", Mode: "once", Hidden: true,
	})
	if err != nil {
		return WakeupNowResult{}, err
	}
	result := WakeupNowResult{WakeupID: util.UUIDToString(rule.ID), Outcome: WakeupNowPending}
	if err := s.dispatch(ctx, rule); err != nil {
		slog.WarnContext(ctx, "wakeup now: dispatch deferred to the scheduler", "wakeup_id", result.WakeupID, "error", err)
		return result, nil
	}
	fired, err := s.Tasks.Queries.LocklessWakeup(ctx, rule.ID)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			slog.WarnContext(ctx, "wakeup now: reload failed", "wakeup_id", result.WakeupID, "error", err)
		}
		return result, nil
	}
	if fired.LastTaskID.Valid {
		result.TaskID, result.Outcome = util.UUIDToString(fired.LastTaskID), WakeupNowQueued
	}
	return result, nil
}

// SweepHiddenWakeups removes one batch of finished hidden rules.
func (s *IssueWakeupService) SweepHiddenWakeups(ctx context.Context, now time.Time) (int64, error) {
	return s.Tasks.Queries.SweepFinishedHiddenWakeups(ctx, db.SweepFinishedHiddenWakeupsParams{
		Cutoff:   pgtype.Timestamptz{Time: now.Add(-HiddenWakeupRetention), Valid: true},
		RowLimit: hiddenWakeupSweepRows,
	})
}
