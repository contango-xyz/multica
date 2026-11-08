package service

// "Wake this agent now" (contango patch 27, docs/contango/PATCHES.md): one run
// with an instruction and no timer. It saves a one-shot rule and fires it at
// once, so the run gets everything a fired rule's run gets (its pending slot,
// the [WAKEUP] prompt, joining a waiting run, cancel on close, the claim
// check). The rule is hidden from every list and swept once finished.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
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
	// RuntimeID, Model and ThinkingLevel ask for a one-run override
	// (contango patch 29). The handler resolves them into RunOverride.
	RuntimeID     string `json:"runtime_id"`
	Model         string `json:"model"`
	ThinkingLevel string `json:"thinking_level"`
	// RunOverride is the validated override; only the handler sets it.
	RunOverride *RunOverride `json:"-"`
}

// WantsRunOverride reports whether the request asked for any override.
func (in WakeupNowInput) WantsRunOverride() bool {
	return in.RuntimeID != "" || in.Model != "" || in.ThinkingLevel != ""
}

// ErrRunOverrideUnavailable refuses an override whose seat cannot take the run
// now: it is offline, or a run of the agent on the issue has not started yet.
// A substitute is never used (owner decision).
var ErrRunOverrideUnavailable = errors.New("run override unavailable")

// RunOverride holds one run's seat, model and effort (contango patch 29). The
// handler resolves it at request time, so Model and ThinkingLevel are the
// final values the run uses: a value left unset by the caller holds the
// agent's own at that moment, cleared when it would not fit the seat.
type RunOverride struct {
	RuntimeID     string `json:"runtime_id"`
	Model         string `json:"model"`
	ThinkingLevel string `json:"thinking_level"`
}

func parseRunOverride(raw []byte) (*RunOverride, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var override RunOverride
	if err := json.Unmarshal(raw, &override); err != nil {
		return nil, err
	}
	return &override, nil
}

// TaskRunOverride returns the override a run was started with, or nil for an
// ordinary run. Being non-nil is what pins the run to its runtime_id.
func TaskRunOverride(task db.AgentTaskQueue) *RunOverride {
	if len(task.Context) == 0 {
		return nil
	}
	var parsed struct {
		RunOverride *RunOverride `json:"run_override"`
	}
	if err := json.Unmarshal(task.Context, &parsed); err != nil {
		return nil
	}
	return parsed.RunOverride
}

// TaskRunPinned reports whether a run keeps its seat regardless of the agent's
// current runtime.
func TaskRunPinned(task db.AgentTaskQueue) bool {
	return TaskRunOverride(task) != nil
}

// checkRunOverrideSeat refuses an override the seat cannot take now. It runs in
// Save's transaction, holding the issue lock, so it sees the same waiting runs
// as the dispatch that follows.
func checkRunOverrideSeat(ctx context.Context, q *db.Queries, override *RunOverride, issueID, agentID, workspaceID pgtype.UUID, now time.Time) error {
	runtimeID, err := wakeupUUID(override.RuntimeID)
	if err != nil || !runtimeID.Valid {
		return fmt.Errorf("%w: invalid runtime", ErrWakeupInput)
	}
	runtime, err := q.GetAgentRuntimeForWorkspace(ctx, db.GetAgentRuntimeForWorkspaceParams{ID: runtimeID, WorkspaceID: workspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: invalid runtime", ErrWakeupInput)
	}
	if err != nil {
		return err
	}
	lastSeen := runtime.LastSeenAt.Time
	if !runtime.LastSeenAt.Valid {
		lastSeen = runtime.UpdatedAt.Time
	}
	if runtime.Status != "online" || lastSeen.Before(now.Add(-RuntimeClaimFreshnessSeconds*time.Second)) {
		return fmt.Errorf("%w: runtime %s is offline", ErrRunOverrideUnavailable, runtime.Name)
	}
	waiting, err := q.HasUnstartedIssueRunOfAgent(ctx, db.HasUnstartedIssueRunOfAgentParams{IssueID: issueID, AgentID: agentID})
	if err != nil {
		return err
	}
	if waiting {
		return fmt.Errorf("%w: a run of this agent on the issue has not started yet; a pinned run cannot join it", ErrRunOverrideUnavailable)
	}
	return nil
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
		Kind: "at", Mode: "once", Hidden: true, RunOverride: in.RunOverride,
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
