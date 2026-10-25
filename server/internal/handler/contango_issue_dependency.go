package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Issue dependencies (contango): "issue X is blocked by issue Y" as data, so the
// board and its automation can rank the critical path instead of reading blockers
// out of comment prose. One edge per pair, stored as type 'blocked_by'.

func dependencyIdentifier(prefix string, number int32) string {
	return prefix + "-" + strconv.Itoa(int(number))
}

// IssueDependencyRef is one side of a dependency edge as the API shows it.
type IssueDependencyRef struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Number     int32  `json:"number"`
	Title      string `json:"title"`
	Status     string `json:"status"`
}

type AddIssueDependencyRequest struct {
	// The issue (UUID or identifier such as CTG-42) this issue is blocked by.
	BlockedBy string `json:"blocked_by"`
}

// dependenciesByIssue returns, for each issue id, the issues it is blocked by and
// the issues it blocks. A failed read leaves both maps empty: dependencies decorate
// a response, they never fail it.
func (h *Handler) dependenciesByIssue(ctx context.Context, wsUUID pgtype.UUID, prefix string, issueIDs []pgtype.UUID) (blockedBy, blocks map[string][]IssueDependencyRef) {
	blockedBy, blocks = map[string][]IssueDependencyRef{}, map[string][]IssueDependencyRef{}
	if len(issueIDs) == 0 {
		return
	}
	ref := func(id pgtype.UUID, number int32, title, status string) IssueDependencyRef {
		return IssueDependencyRef{ID: uuidToString(id), Identifier: dependencyIdentifier(prefix, number), Number: number, Title: title, Status: status}
	}
	if rows, err := h.Queries.ListBlockedByForIssues(ctx, db.ListBlockedByForIssuesParams{IssueIds: issueIDs, WorkspaceID: wsUUID}); err != nil {
		slog.Warn("ListBlockedByForIssues failed", "error", err)
	} else {
		for _, r := range rows {
			k := uuidToString(r.IssueID)
			blockedBy[k] = append(blockedBy[k], ref(r.ID, r.Number, r.Title, r.Status))
		}
	}
	if rows, err := h.Queries.ListBlocksForIssues(ctx, db.ListBlocksForIssuesParams{IssueIds: issueIDs, WorkspaceID: wsUUID}); err != nil {
		slog.Warn("ListBlocksForIssues failed", "error", err)
	} else {
		for _, r := range rows {
			k := uuidToString(r.IssueID)
			blocks[k] = append(blocks[k], ref(r.ID, r.Number, r.Title, r.Status))
		}
	}
	return
}

// attachDependencies sets blocked_by and blocks (empty lists, not absent) on each response.
func (h *Handler) attachDependencies(ctx context.Context, wsUUID pgtype.UUID, prefix string, resp []IssueResponse) {
	ids := make([]pgtype.UUID, len(resp))
	for i := range resp {
		ids[i] = parseUUID(resp[i].ID)
	}
	blockedBy, blocks := h.dependenciesByIssue(ctx, wsUUID, prefix, ids)
	for i := range resp {
		by, bl := blockedBy[resp[i].ID], blocks[resp[i].ID]
		if by == nil {
			by = []IssueDependencyRef{}
		}
		if bl == nil {
			bl = []IssueDependencyRef{}
		}
		resp[i].BlockedBy, resp[i].Blocks = &by, &bl
	}
}

func (h *Handler) writeIssueDependencies(w http.ResponseWriter, r *http.Request, issue db.Issue, revision int64) {
	prefix := h.getIssuePrefix(r.Context(), issue.WorkspaceID)
	blockedBy, blocks := h.dependenciesByIssue(r.Context(), issue.WorkspaceID, prefix, []pgtype.UUID{issue.ID})
	by, bl := blockedBy[uuidToString(issue.ID)], blocks[uuidToString(issue.ID)]
	if by == nil {
		by = []IssueDependencyRef{}
	}
	if bl == nil {
		bl = []IssueDependencyRef{}
	}
	if revision == 0 {
		revision = int64(issue.Revision)
	}
	writeJSON(w, http.StatusOK, map[string]any{"blocked_by": by, "blocks": bl, "issue_revision": revision})
}

// ListIssueDependencies returns what an issue is blocked by and what it blocks.
func (h *Handler) ListIssueDependencies(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	h.writeIssueDependencies(w, r, issue, 0)
}

// AddIssueDependency records that the issue is blocked by another issue of the
// same workspace. Idempotent; refuses a self-dependency and a cycle.
func (h *Handler) AddIssueDependency(w http.ResponseWriter, r *http.Request) {
	r = h.withWakeupActor(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req AddIssueDependencyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.BlockedBy == "" {
		writeError(w, http.StatusBadRequest, "blocked_by is required")
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	blocker, ok := h.loadIssueForUser(w, r, req.BlockedBy)
	if !ok {
		return
	}
	if blocker.ID == issue.ID {
		writeError(w, http.StatusBadRequest, "an issue cannot be blocked by itself")
		return
	}
	cycles, err := h.Queries.IssueBlockedByWouldCycle(r.Context(), db.IssueBlockedByWouldCycleParams{IssueID: issue.ID, BlockedByID: blocker.ID})
	if err != nil {
		slog.Warn("IssueBlockedByWouldCycle failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to add dependency")
		return
	}
	if cycles {
		writeError(w, http.StatusConflict, "dependency would create a cycle: the blocker already waits on this issue")
		return
	}
	added, err := wakeupWrite(h, r, func(q *db.Queries) (db.AddIssueBlockedByRow, error) {
		return q.AddIssueBlockedBy(r.Context(), db.AddIssueBlockedByParams{IssueID: issue.ID, BlockedByID: blocker.ID, WorkspaceID: issue.WorkspaceID})
	})
	if err != nil {
		slog.Warn("AddIssueBlockedBy failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to add dependency")
		return
	}
	if added.Changed {
		h.recordDependencyActivity(r, userID, issue, blocker, "dependency_added")
	}
	h.writeIssueDependencies(w, r, issue, added.IssueRevision)
}

// RemoveIssueDependency removes "the issue is blocked by {blockerId}". Removing an
// edge that does not exist succeeds without a change.
func (h *Handler) RemoveIssueDependency(w http.ResponseWriter, r *http.Request) {
	r = h.withWakeupActor(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	blocker, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "blockerId"))
	if !ok {
		return
	}
	removed, err := wakeupWrite(h, r, func(q *db.Queries) (db.RemoveIssueBlockedByRow, error) {
		return q.RemoveIssueBlockedBy(r.Context(), db.RemoveIssueBlockedByParams{IssueID: issue.ID, BlockedByID: blocker.ID, WorkspaceID: issue.WorkspaceID})
	})
	if err != nil {
		slog.Warn("RemoveIssueBlockedBy failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to remove dependency")
		return
	}
	if removed.Changed {
		h.recordDependencyActivity(r, userID, issue, blocker, "dependency_removed")
	}
	h.writeIssueDependencies(w, r, issue, removed.IssueRevision)
}

func (h *Handler) recordDependencyActivity(r *http.Request, userID string, issue, blocker db.Issue, action string) {
	actorType, actorID := h.resolveActor(r, userID, uuidToString(issue.WorkspaceID))
	prefix := h.getIssuePrefix(r.Context(), issue.WorkspaceID)
	details, _ := json.Marshal(map[string]string{
		"blocked_by_id":         uuidToString(blocker.ID),
		"blocked_by_identifier": dependencyIdentifier(prefix, blocker.Number),
	})
	activity, err := h.Queries.CreateActivity(r.Context(), db.CreateActivityParams{
		ID:          dbid.NewV7(),
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.ID,
		ActorType:   strToText(actorType),
		ActorID:     optionalActorUUID(actorID),
		Action:      action,
		Details:     details,
	})
	if err != nil {
		slog.Warn("record dependency activity failed", "err", err)
		return
	}
	h.publish(protocol.EventActivityCreated, uuidToString(issue.WorkspaceID), actorType, actorID, map[string]any{
		"issue_id": uuidToString(issue.ID),
		"entry": map[string]any{
			"type":       "activity",
			"id":         uuidToString(activity.ID),
			"actor_type": actorType,
			"actor_id":   actorID,
			"action":     activity.Action,
			"details":    json.RawMessage(details),
			"created_at": timestampToString(activity.CreatedAt),
		},
	})
}
