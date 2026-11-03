package handler

// Issue origin from a comment (contango, docs/contango/ISSUE-ORIGIN.md).
//
// `multica issue create --from-comment <id>` (POST /api/issues with
// source_comment_id) and `multica issue set-source <issue> --from-comment
// <id>` (POST /api/issues/{id}/source-context) record which comment an issue
// came from, with the same immutable snapshot the UI's comment-to-sub-issue
// flow captures. Unlike that flow they never change the parent: the comment
// may sit on any issue in the workspace.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// sourceCommentCapture is a captured source comment ready to persist, with
// the compensation for cloned attachment objects if the write fails.
type sourceCommentCapture struct {
	capture service.SourceContextCapture
	limits  service.SourceContextLimitUsage
	// cleanup deletes cloned objects unless the context row was persisted.
	cleanup func()
}

// captureSourceFromComment snapshots the comment's issue and thread (and
// clones its attachments) for the caller. The comment must be in this
// workspace and its issue visible to the caller, the same access commenting
// on it needs. ok=false means a response was written.
func (h *Handler) captureSourceFromComment(w http.ResponseWriter, r *http.Request, workspaceID, userID pgtype.UUID, rawCommentID, field string) (*sourceCommentCapture, bool) {
	commentID, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(rawCommentID), field)
	if !ok {
		return nil, false
	}
	comment, err := h.Queries.GetCommentInWorkspace(r.Context(), db.GetCommentInWorkspaceParams{ID: commentID, WorkspaceID: workspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "comment not found in this workspace")
		return nil, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load comment")
		return nil, false
	}
	if _, ok := h.loadIssueForUser(w, r, uuidToString(comment.IssueID)); !ok {
		return nil, false
	}
	build, err := service.BuildSourceContext(r.Context(), h.Queries, workspaceID, commentID)
	if err != nil {
		h.writeSourceContextError(w, err, build.Limits)
		return nil, false
	}
	contextID := dbid.NewV7()
	capture, objectKeys, err := h.cloneSourceContext(r.Context(), workspaceID, userID, contextID, build)
	if err != nil {
		slog.Warn("source context capture failed", append(logger.RequestAttrs(r), "error", err)...)
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": "source_context_attachment_copy_failed", "error": "failed to copy source attachments"})
		return nil, false
	}
	cleanup := func() {
		if len(objectKeys) == 0 {
			return
		}
		_, lookupErr := h.Queries.GetIssueSourceContextByID(context.Background(), db.GetIssueSourceContextByIDParams{WorkspaceID: workspaceID, ID: capture.ID})
		if !errors.Is(lookupErr, pgx.ErrNoRows) {
			// Persisted, or ownership uncertain: the intent reconciler owns it.
			return
		}
		for _, key := range objectKeys {
			h.Storage.Delete(context.Background(), key)
		}
	}
	return &sourceCommentCapture{capture: capture, limits: build.Limits, cleanup: cleanup}, true
}

// agentTaskForRequest is the acting agent task when an agent token made the
// request (the server-trusted X-Task-ID, re-checked against the agent), else
// an invalid UUID.
func (h *Handler) agentTaskForRequest(r *http.Request, creatorType, actorID string) pgtype.UUID {
	if creatorType != "agent" {
		return pgtype.UUID{}
	}
	taskUUID, err := util.ParseUUID(r.Header.Get("X-Task-ID"))
	if err != nil {
		return pgtype.UUID{}
	}
	task, err := h.Queries.GetAgentTask(r.Context(), taskUUID)
	if err != nil || uuidToString(task.AgentID) != actorID {
		return pgtype.UUID{}
	}
	return taskUUID
}

type setIssueSourceRequest struct {
	CommentID string `json:"comment_id"`
	// Force replaces a source the issue already has.
	Force bool `json:"force"`
}

// SetIssueSourceContext handles POST /api/issues/{id}/source-context: record
// the comment an existing issue came from. Refused with 409
// source_context_already_attached when it has one, unless force.
func (h *Handler) SetIssueSourceContext(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req setIssueSourceRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.CommentID) == "" {
		writeError(w, http.StatusBadRequest, "comment_id is required")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user_id")
	if !ok {
		return
	}
	workspaceID := issue.WorkspaceID
	src, ok := h.captureSourceFromComment(w, r, workspaceID, userUUID, req.CommentID, "comment_id")
	if !ok {
		return
	}
	actorType, actorID := h.resolveActor(r, userID, uuidToString(workspaceID))
	var keyFromURL func(string) string
	if h.Storage != nil {
		keyFromURL = h.Storage.KeyFromURL
	}
	result, err := h.IssueService.AttachSourceContext(r.Context(), workspaceID, issue.ID, src.capture,
		h.agentTaskForRequest(r, actorType, actorID), req.Force, keyFromURL)
	if err != nil {
		src.cleanup()
		if errors.Is(err, service.ErrSourceTargetIssueNotFound) {
			writeError(w, http.StatusNotFound, "issue not found")
			return
		}
		h.writeSourceContextError(w, err, src.limits)
		return
	}
	if len(result.ReplacedObjectURLs) > 0 {
		h.deleteS3Objects(r.Context(), result.ReplacedObjectURLs)
	}
	resp := issueToResponse(result.Issue, h.getIssuePrefix(r.Context(), workspaceID))
	h.fillStatusCategory(r.Context(), workspaceID, &resp)
	h.publish(protocol.EventIssueUpdated, uuidToString(workspaceID), actorType, actorID, map[string]any{"issue": resp})
	slog.Info("issue source set from comment", append(sourceContextAuditAttrs(r, src.capture.ID, src.capture.Snapshot.SourceIssue.ID,
		src.capture.Snapshot.AnchorCommentID, userUUID, "set_source", src.limits, "success"), "target_issue_id", uuidToString(issue.ID))...)
	// Return the issue with its new source_context, as GetIssue would.
	if detail, err := h.issueSourceContextDetail(r.Context(), result.Issue); err == nil {
		resp.SourceContext = detail
	}
	writeJSON(w, http.StatusOK, resp)
}

// isSourceContextError: a create failed on the source comment (changed,
// deleted, too large), not on the issue itself.
func isSourceContextError(err error) bool {
	for _, target := range []error{
		service.ErrSourceContextChanged, service.ErrAnchorCommentDeleted, service.ErrSourceIssueDeleted,
		service.ErrSourceContextInvalid, service.ErrSourceContextTooLarge, service.ErrSourceContextAlreadyAttached,
	} {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}
