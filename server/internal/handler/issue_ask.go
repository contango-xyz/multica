package handler

// Asks as real objects (contango patch 30, docs/contango/PATCHES.md). Creating
// an ask delegates to CreateComment, like the one-tap reply in
// inbox_signal_reply.go: the comment gets the same auth, parent checks,
// mentions, notifications and agent triggers as a typed one, and the ask row
// joins its transaction through the context.
//
// Permissions. Identity comes from resolveActor, the same check CreateComment
// uses, so a task token is the agent its token row names. Agents may create
// asks and resolve or withdraw only asks they created. Members may resolve and
// withdraw any ask in the workspace. answered_by is always the authenticated
// caller, never a request field, and the "comment" and "one_tap" answers exist
// only on their real paths, which require a member who is not automation: a
// task token cannot record a person's answer.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// RegisterIssueAskRoutes mounts the ask API inside the workspace-member group.
func RegisterIssueAskRoutes(r chi.Router, h *Handler) {
	r.Post("/api/issues/{id}/asks", h.CreateIssueAsk)
	r.Get("/api/issues/{id}/asks", h.ListIssueAsks)
	r.Get("/api/issues/{id}/asks/oldest-open", h.GetOldestOpenIssueAsk)
	r.Get("/api/asks/{askId}", h.GetIssueAsk)
	r.Post("/api/asks/{askId}/resolve", h.ResolveIssueAsk)
	r.Post("/api/asks/{askId}/withdraw", h.WithdrawIssueAsk)
}

type IssueAskResponse struct {
	ID              string                   `json:"id"`
	WorkspaceID     string                   `json:"workspace_id"`
	IssueID         string                   `json:"issue_id"`
	CommentID       string                   `json:"comment_id"`
	TaskID          *string                  `json:"task_id"`
	PRID            *string                  `json:"pr_id"`
	AuthorType      string                   `json:"author_type"`
	AuthorID        string                   `json:"author_id"`
	AddresseeType   string                   `json:"addressee_type"`
	AddresseeID     *string                  `json:"addressee_id"`
	AddresseeRole   *string                  `json:"addressee_role"`
	Kind            string                   `json:"kind"`
	Topic           string                   `json:"topic"`
	Options         []service.IssueAskOption `json:"options"`
	Recommended     *string                  `json:"recommended"`
	DefaultOption   *string                  `json:"default_option"`
	Reversible      bool                     `json:"reversible"`
	State           string                   `json:"state"`
	AnswerText      *string                  `json:"answer_text"`
	AnswerCommentID *string                  `json:"answer_comment_id"`
	AnsweredByType  *string                  `json:"answered_by_type"`
	AnsweredBy      *string                  `json:"answered_by"`
	AnsweredVia     *string                  `json:"answered_via"`
	ExpiresAt       *string                  `json:"expires_at"`
	Source          string                   `json:"source"`
	CreatedAt       string                   `json:"created_at"`
	UpdatedAt       string                   `json:"updated_at"`
	ClosedAt        *string                  `json:"closed_at"`
}

func issueAskToResponse(a db.IssueAsk) IssueAskResponse {
	options := []service.IssueAskOption{}
	_ = json.Unmarshal(a.Options, &options)
	return IssueAskResponse{
		ID: uuidToString(a.ID), WorkspaceID: uuidToString(a.WorkspaceID), IssueID: uuidToString(a.IssueID),
		CommentID: uuidToString(a.CommentID), TaskID: uuidToPtr(a.TaskID), PRID: uuidToPtr(a.PrID),
		AuthorType: a.AuthorType, AuthorID: uuidToString(a.AuthorID),
		AddresseeType: a.AddresseeType, AddresseeID: uuidToPtr(a.AddresseeID), AddresseeRole: textToPtr(a.AddresseeRole),
		Kind: a.Kind, Topic: a.Topic, Options: options,
		Recommended: textToPtr(a.Recommended), DefaultOption: textToPtr(a.DefaultOption), Reversible: a.Reversible,
		State: a.State, AnswerText: textToPtr(a.AnswerText), AnswerCommentID: uuidToPtr(a.AnswerCommentID),
		AnsweredByType: textToPtr(a.AnsweredByType), AnsweredBy: uuidToPtr(a.AnsweredBy), AnsweredVia: textToPtr(a.AnsweredVia),
		ExpiresAt: timestampToPtr(a.ExpiresAt), Source: a.Source,
		CreatedAt: timestampToString(a.CreatedAt), UpdatedAt: timestampToString(a.UpdatedAt), ClosedAt: timestampToPtr(a.ClosedAt),
	}
}

func asksEnabled(w http.ResponseWriter) bool {
	if !service.AsksEnabled() {
		writeError(w, http.StatusForbidden, "asks are turned off on this server (MULTICA_ASKS=0)")
		return false
	}
	return true
}

// askDraftKey carries a pending ask from CreateIssueAsk into CreateComment's
// transaction; created is set there, so a successful comment always has its row.
type askDraftKey struct{}

type askDraft struct {
	input   service.IssueAskInput
	created *db.IssueAsk
}

// askOneTapKey marks a one-tap reply with the ask it answers.
type askOneTapKey struct{}

// withAskOneTap tags a signal-reply's delegated request with its ask; no ask
// (a signal raised before the feeder knew about asks) leaves it a plain reply.
func withAskOneTap(r *http.Request, askID string) *http.Request {
	if askID == "" {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), askOneTapKey{}, askID))
}

// createCommentWithAsk is CreateComment's write; on an ask's comment it adds
// the row in the same transaction. Comments that are not asks pass through.
func (h *Handler) createCommentWithAsk(ctx context.Context, q *db.Queries, params db.CreateCommentParams) (db.CreateCommentRow, error) {
	created, err := q.CreateComment(ctx, params)
	if err != nil {
		return created, err
	}
	draft, ok := ctx.Value(askDraftKey{}).(*askDraft)
	if !ok {
		return created, nil
	}
	ask, err := service.CreateAskForComment(ctx, q, draft.input, created.Comment())
	if err != nil {
		return created, err
	}
	draft.created = &ask
	return created, nil
}

// answerAskFromComment is the hook after a comment is saved: a person's reply
// answers the ask in its thread and a one-tap reply answers its ask. It runs
// before the comment's agent triggers, so a run the reply wakes sees the ask
// answered. Failures are logged and never fail the comment: the ask just stays
// open, and the marker readers are unaffected.
func (h *Handler) answerAskFromComment(r *http.Request, comment db.Comment) {
	if !service.AsksEnabled() {
		return
	}
	if _, isAskComment := r.Context().Value(askDraftKey{}).(*askDraft); isAskComment {
		return
	}
	if comment.AuthorType != "member" || isBotMember(comment.AuthorID) || isNoteComment(comment.Content) {
		return
	}
	var err error
	if id, ok := r.Context().Value(askOneTapKey{}).(string); ok {
		var askID pgtype.UUID
		if askID, err = parseUUIDLoose(id); err == nil {
			err = service.AnswerAskFromOneTap(r.Context(), h.Queries, askID, comment)
		}
	} else {
		err = service.AnswerAskFromThreadReply(r.Context(), h.Queries, comment)
	}
	if err != nil {
		slog.Warn("answer ask from comment failed", append(logger.RequestAttrs(r), "error", err, "comment_id", uuidToString(comment.ID))...)
	}
}

func (h *Handler) CreateIssueAsk(w http.ResponseWriter, r *http.Request) {
	if !asksEnabled(w) {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var in service.IssueAskInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// The prose fields are sanitized with the comment; these land on the row.
	for _, f := range []*string{&in.Topic, &in.Recommended, &in.DefaultOption} {
		*f = sanitizeNullBytes(*f)
	}
	for i := range in.Options {
		in.Options[i].Label, in.Options[i].Reply = sanitizeNullBytes(in.Options[i].Label), sanitizeNullBytes(in.Options[i].Reply)
	}
	if err := in.Normalize(); err != nil {
		writeAskInputError(w, err)
		return
	}
	handle, ok := h.resolveAskAddressee(w, r, issue, &in)
	if !ok {
		return
	}
	if in.PRID != "" {
		prID, ok := parseUUIDOrBadRequest(w, in.PRID, "pr_id")
		if !ok {
			return
		}
		if _, err := h.Queries.GetGitHubPullRequestInWorkspace(r.Context(), db.GetGitHubPullRequestInWorkspaceParams{ID: prID, WorkspaceID: issue.WorkspaceID}); err != nil {
			writeError(w, http.StatusBadRequest, "pr_id is not a pull request in this workspace")
			return
		}
	}

	draft := &askDraft{input: in}
	body := CreateCommentRequest{Content: service.RenderAskComment(in, handle)}
	if in.ParentID != "" {
		body.ParentID = &in.ParentID
	}
	out := &bufferedResponse{header: http.Header{}}
	ctx := context.WithValue(r.Context(), askDraftKey{}, draft)
	h.CreateComment(out, commentRequestFor(r.WithContext(ctx), uuidToString(issue.ID), body))
	if out.status >= 300 {
		// The comment handler's refusal is the answer (bad parent, a run that
		// must reply under its trigger comment, and so on).
		for k, v := range out.header {
			w.Header()[k] = v
		}
		w.WriteHeader(out.status)
		_, _ = w.Write(out.body.Bytes())
		return
	}
	if draft.created == nil {
		writeError(w, http.StatusInternalServerError, "failed to create ask")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ask":     issueAskToResponse(*draft.created),
		"comment": json.RawMessage(out.body.Bytes()),
	})
}

// resolveAskAddressee checks the addressee is in the workspace and returns the
// member's mention handle (the email up to the @, as asks are written today).
func (h *Handler) resolveAskAddressee(w http.ResponseWriter, r *http.Request, issue db.Issue, in *service.IssueAskInput) (string, bool) {
	if in.AddresseeType != service.AskAddresseeMember {
		return "", true
	}
	userID, ok := parseUUIDOrBadRequest(w, in.AddresseeID, "addressee_id")
	if !ok {
		return "", false
	}
	if _, err := h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{UserID: userID, WorkspaceID: issue.WorkspaceID}); err != nil {
		writeError(w, http.StatusBadRequest, "addressee is not a member of this workspace")
		return "", false
	}
	user, err := h.Queries.GetUser(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "addressee is not a member of this workspace")
		return "", false
	}
	in.AddresseeID = uuidToString(userID)
	handle, _, _ := strings.Cut(user.Email, "@")
	return handle, true
}

func writeAskInputError(w http.ResponseWriter, err error) {
	var bad *service.AskInputError
	if errors.As(err, &bad) {
		writeError(w, http.StatusBadRequest, bad.Msg)
		return
	}
	writeError(w, http.StatusInternalServerError, "failed to process ask")
}

func (h *Handler) ListIssueAsks(w http.ResponseWriter, r *http.Request) {
	if !asksEnabled(w) {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var state pgtype.Text
	if s := r.URL.Query().Get("state"); s != "" {
		state = pgtype.Text{String: s, Valid: true}
	}
	limit := int32(200)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 500 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 500")
			return
		}
		limit = int32(n)
	}
	rows, err := h.Queries.ListIssueAsks(r.Context(), db.ListIssueAsksParams{
		IssueID: issue.ID, WorkspaceID: issue.WorkspaceID, State: state, RowLimit: limit,
	})
	if err != nil {
		slog.Warn("list asks failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list asks")
		return
	}
	out := make([]IssueAskResponse, 0, len(rows))
	for _, a := range rows {
		out = append(out, issueAskToResponse(a))
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) GetOldestOpenIssueAsk(w http.ResponseWriter, r *http.Request) {
	if !asksEnabled(w) {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	ask, err := h.Queries.GetOldestOpenIssueAsk(r.Context(), db.GetOldestOpenIssueAskParams{IssueID: issue.ID, WorkspaceID: issue.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "no open ask on this issue")
		return
	}
	if err != nil {
		slog.Warn("get oldest open ask failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load ask")
		return
	}
	writeJSON(w, http.StatusOK, issueAskToResponse(ask))
}

// loadIssueAsk returns the ask after the same issue access check its issue's
// comments get; anything else is a 404.
func (h *Handler) loadIssueAsk(w http.ResponseWriter, r *http.Request) (db.IssueAsk, bool) {
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "askId"), "ask id")
	if !ok {
		return db.IssueAsk{}, false
	}
	workspace, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return db.IssueAsk{}, false
	}
	ask, err := h.Queries.GetIssueAsk(r.Context(), db.GetIssueAskParams{ID: id, WorkspaceID: workspace})
	if err != nil {
		writeError(w, http.StatusNotFound, "ask not found")
		return db.IssueAsk{}, false
	}
	if _, ok := h.loadIssueForUser(w, r, uuidToString(ask.IssueID)); !ok {
		return db.IssueAsk{}, false
	}
	return ask, true
}

func (h *Handler) GetIssueAsk(w http.ResponseWriter, r *http.Request) {
	if !asksEnabled(w) {
		return
	}
	ask, ok := h.loadIssueAsk(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, issueAskToResponse(ask))
}

type ResolveIssueAskRequest struct {
	AnsweredVia     string `json:"answered_via"`
	AnswerText      string `json:"answer_text"`
	AnswerCommentID string `json:"answer_comment_id"`
}

// askCaller loads the ask and the caller, and refuses an agent acting on an ask
// it did not create.
func (h *Handler) askCaller(w http.ResponseWriter, r *http.Request, verb string) (ask db.IssueAsk, actorType string, actorID pgtype.UUID, ok bool) {
	if ask, ok = h.loadIssueAsk(w, r); !ok {
		return ask, "", actorID, false
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return ask, "", actorID, false
	}
	actorType, id := h.resolveActor(r, userID, uuidToString(ask.WorkspaceID))
	if actorType == "agent" && (ask.AuthorType != "agent" || uuidToString(ask.AuthorID) != id) {
		writeError(w, http.StatusForbidden, "agents may "+verb+" only asks they created")
		return ask, "", actorID, false
	}
	return ask, actorType, parseUUID(id), true
}

func (h *Handler) ResolveIssueAsk(w http.ResponseWriter, r *http.Request) {
	if !asksEnabled(w) {
		return
	}
	ask, actorType, actorID, ok := h.askCaller(w, r, "resolve")
	if !ok {
		return
	}
	var req ResolveIssueAskRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch req.AnsweredVia {
	case service.AskViaStatusMove, service.AskViaPRApproved, service.AskViaDefaultApplied:
	case service.AskViaOps:
		if actorType == "agent" {
			writeError(w, http.StatusForbidden, "ops closes an ask on the operator's behalf; agents cannot use it")
			return
		}
	default:
		// comment and one_tap are written only by the reply paths.
		writeError(w, http.StatusBadRequest, "answered_via must be one of status_move, pr_approved, default_applied, ops")
		return
	}
	text := sanitizeNullBytes(req.AnswerText)
	if req.AnsweredVia == service.AskViaDefaultApplied {
		if !ask.DefaultOption.Valid {
			writeError(w, http.StatusConflict, "this ask has no default to apply")
			return
		}
		if text == "" {
			text = ask.DefaultOption.String
		}
	}
	var answerComment pgtype.UUID
	if req.AnswerCommentID != "" {
		id, ok := parseUUIDOrBadRequest(w, req.AnswerCommentID, "answer_comment_id")
		if !ok {
			return
		}
		c, err := h.Queries.GetComment(r.Context(), id)
		if err != nil || c.IssueID != ask.IssueID {
			writeError(w, http.StatusBadRequest, "answer_comment_id is not a comment on the ask's issue")
			return
		}
		answerComment = id
	}
	updated, err := service.AnswerAsk(r.Context(), h.Queries, service.AskAnswer{
		AskID: ask.ID, Workspace: ask.WorkspaceID, Text: text, CommentID: answerComment,
		ByType: actorType, By: actorID, Via: req.AnsweredVia,
	})
	h.writeAskClose(w, r, ask, updated, err)
}

type WithdrawIssueAskRequest struct {
	Reason string `json:"reason"`
}

func (h *Handler) WithdrawIssueAsk(w http.ResponseWriter, r *http.Request) {
	if !asksEnabled(w) {
		return
	}
	ask, actorType, actorID, ok := h.askCaller(w, r, "withdraw")
	if !ok {
		return
	}
	var req WithdrawIssueAskRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	updated, err := service.WithdrawAsk(r.Context(), h.Queries, ask.ID, ask.WorkspaceID, sanitizeNullBytes(req.Reason), actorType, actorID)
	h.writeAskClose(w, r, ask, updated, err)
}

func (h *Handler) writeAskClose(w http.ResponseWriter, r *http.Request, ask, updated db.IssueAsk, err error) {
	if service.IsNoOpenAsk(err) {
		current := ask.State
		if reread, rerr := h.Queries.GetIssueAsk(r.Context(), db.GetIssueAskParams{ID: ask.ID, WorkspaceID: ask.WorkspaceID}); rerr == nil {
			current = reread.State
		}
		writeError(w, http.StatusConflict, "this ask is already "+current)
		return
	}
	if err != nil {
		slog.Warn("close ask failed", append(logger.RequestAttrs(r), "error", err, "ask_id", uuidToString(ask.ID))...)
		writeError(w, http.StatusInternalServerError, "failed to update ask")
		return
	}
	writeJSON(w, http.StatusOK, issueAskToResponse(updated))
}
