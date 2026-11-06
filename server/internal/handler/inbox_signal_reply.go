package handler

// One-tap answers on smart inbox signals (contango patch 18,
// docs/contango/SMART-INBOX.md "One-tap answers").
//
// The feeder may attach up to two replies to a signal ({label, content,
// parent_comment_id}). The recipient taps one, confirms, and the client calls
// POST /api/inbox/{id}/signal-reply. This handler checks the click (the signal
// is the caller's own, live, and the reply is still what they saw), then posts
// the comment through the ordinary CreateComment handler on the same request:
// same user, same auth, same permission checks, mentions, notifications and
// agent triggers as a typed reply. Nothing is ever posted without that click.
// On success the signal is archived for the caller (not resolved): it stays
// quiet, and the feeder resolves it when the ask closes.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// validSignalReplies checks, at upsert time, that replies can only land on the
// signal's own issue: a signal with replies must have an issue, and each
// reply's parent comment must be a live comment on it. ok=false means a 400
// was written.
func (h *Handler) validSignalReplies(w http.ResponseWriter, r *http.Request, issueID pgtype.UUID, replies []signalReply) bool {
	if len(replies) == 0 {
		return true
	}
	if !issueID.Valid {
		writeError(w, http.StatusBadRequest, "replies need an issue_id")
		return false
	}
	for _, rp := range replies {
		if rp.ParentCommentID == "" {
			continue
		}
		c, err := h.Queries.GetComment(r.Context(), parseUUID(rp.ParentCommentID))
		if err != nil || c.IssueID != issueID || c.DeletedAt.Valid {
			writeError(w, http.StatusBadRequest, "reply parent_comment_id is not a comment on the signal's issue")
			return false
		}
	}
	return true
}

type signalReplyRequest struct {
	// Index of the reply in the signal's details.replies.
	Index *int `json:"index"`
	// Content the client showed in its confirm step; must still match, so a
	// feeder update between render and tap never posts something unseen.
	Content string `json:"content"`
}

// ReplyToInboxSignal handles POST /api/inbox/{id}/signal-reply.
func (h *Handler) ReplyToInboxSignal(w http.ResponseWriter, r *http.Request) {
	// Recipient check: anyone else's item (or another workspace's) is a 404.
	item, ok := h.loadInboxItemForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req signalReplyRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if item.Type != "signal" {
		writeError(w, http.StatusBadRequest, "not a signal")
		return
	}
	var details struct {
		signalDetails
		ResolvedAt string `json:"resolved_at"`
	}
	if err := json.Unmarshal(item.Details, &details); err != nil {
		writeError(w, http.StatusConflict, "this signal has no replies")
		return
	}
	if details.ResolvedAt != "" {
		writeError(w, http.StatusConflict, "this ask is already closed")
		return
	}
	if req.Index == nil || *req.Index < 0 || *req.Index >= len(details.Replies) {
		writeError(w, http.StatusConflict, "this reply is no longer offered")
		return
	}
	reply := details.Replies[*req.Index]
	if strings.TrimSpace(req.Content) != reply.Content {
		writeError(w, http.StatusConflict, "this reply is no longer offered")
		return
	}
	if !item.IssueID.Valid || reply.Content == "" || runeLen(reply.Content) > signalReplyMaxLen {
		writeError(w, http.StatusConflict, "this reply is no longer offered")
		return
	}

	// Post exactly as the caller would from the issue page.
	issueID := uuidToString(item.IssueID)
	body := CreateCommentRequest{Content: reply.Content}
	if reply.ParentCommentID != "" {
		p := reply.ParentCommentID
		body.ParentID = &p
	}
	out := &bufferedResponse{header: http.Header{}}
	h.CreateComment(out, commentRequestFor(r, issueID, body))
	if out.status >= 300 {
		// Pass the comment handler's refusal through unchanged.
		for k, v := range out.header {
			w.Header()[k] = v
		}
		w.WriteHeader(out.status)
		_, _ = w.Write(out.body.Bytes())
		return
	}

	// Answered: archive for the caller, issue-wide like the inbox's own archive
	// (the mentions that carried the ask go with it; later entries stay).
	archived, err := h.Queries.ArchiveInboxItem(r.Context(), item.ID)
	if err != nil {
		slog.Warn("signal reply: archive failed", append(logger.RequestAttrs(r), "error", err)...)
		archived = item
	} else {
		if _, err := h.Queries.ArchiveInboxByIssue(r.Context(), db.ArchiveInboxByIssueParams{
			WorkspaceID: item.WorkspaceID, RecipientType: item.RecipientType,
			RecipientID: item.RecipientID, IssueID: item.IssueID,
		}); err != nil {
			slog.Warn("signal reply: archive issue entries failed", append(logger.RequestAttrs(r), "error", err)...)
		}
		h.publish(protocol.EventInboxArchived, uuidToString(item.WorkspaceID), "member", requestUserID(r), map[string]any{
			"item_id":      uuidToString(item.ID),
			"issue_id":     uuidToPtr(item.IssueID),
			"recipient_id": uuidToString(item.RecipientID),
		})
	}
	resp := h.enrichInboxResponse(r.Context(), inboxToResponse(archived), archived.IssueID)
	writeJSON(w, http.StatusCreated, map[string]any{
		"comment": json.RawMessage(out.body.Bytes()),
		"item":    resp,
	})
}

// commentRequestFor turns the click into the request CreateComment expects:
// the same context (user, workspace, actor source) and headers, the issue in
// the route, and the comment as the body.
func commentRequestFor(r *http.Request, issueID string, body CreateCommentRequest) *http.Request {
	raw, _ := json.Marshal(body)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", issueID)
	r2 := r.Clone(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	r2.URL.Path = "/api/issues/" + issueID + "/comments"
	r2.Body = io.NopCloser(bytes.NewReader(raw))
	r2.ContentLength = int64(len(raw))
	r2.Header.Set("Content-Type", "application/json")
	return r2
}

// bufferedResponse captures a delegated handler's response.
type bufferedResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (b *bufferedResponse) Header() http.Header { return b.header }

func (b *bufferedResponse) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}

func (b *bufferedResponse) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(p)
}
