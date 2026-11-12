package handler

// Smart inbox signals (contango, docs/contango/SMART-INBOX.md).
//
// A signal is an inbox item of type "signal" that an external feeder (the ops
// job) raises for one member and later resolves. The feeder owns the policy;
// this file only stores, notifies and archives. Signals are created only for
// recipients on MULTICA_SMART_INBOX_EMAILS; for anyone else both endpoints
// answer 204 so the feeder needs no flag logic of its own.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	signalKeyMaxLen     = 200
	signalTitleMaxLen   = 60
	signalSummaryMaxLen = 140
	signalBodyMaxLen    = 600
	signalMaxActions    = 3
	signalLabelMaxLen   = 40
	signalURLMaxLen     = 2000
	signalMaxBlocks     = 10000
	// One-tap answers (patch 18): at most 2 replies, each a short literal
	// answer such as "agree" or "approve pairing".
	signalMaxReplies  = 2
	signalReplyMaxLen = 500
	// Inbox tabs (contango patch 43): the optional plain-words brief and merge
	// facts. Plain text, shown as is.
	signalBriefMaxLen     = 600
	signalBriefLineMaxLen = 300
	signalMergeTextMaxLen = 300
	signalMergeMaxLines   = 1_000_000
)

// SignalGroups are the smart-inbox sections a signal can belong to.
var signalGroups = map[string]bool{
	"merge": true, "decision": true, "access": true, "stalled": true,
	"blocking": true, "alert": true, "fyi": true,
}

var signalSeverities = map[string]bool{"action_required": true, "attention": true, "info": true}

var signalPriorities = map[string]bool{"urgent": true, "high": true, "medium": true, "low": true, "none": true}

// signalPushPrefKey is the notification-preference key that controls pushes
// for a signal group. Values are "all" / "muted" like every other group.
func signalPushPrefKey(group string) string { return "signal_" + group }

// signalPushEnabled: every group pushes unless muted, except fyi, which
// pushes only when explicitly set to "all".
func signalPushEnabled(prefs map[string]string, group string) bool {
	v := prefs[signalPushPrefKey(group)]
	if group == "fyi" {
		return v == "all"
	}
	return v != "muted"
}

// ParseSmartInboxEmails splits MULTICA_SMART_INBOX_EMAILS (comma-separated)
// into a lowercase set. Empty means nobody is enabled.
func ParseSmartInboxEmails(raw string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		if e := strings.ToLower(strings.TrimSpace(part)); e != "" {
			out[e] = true
		}
	}
	return out
}

func smartInboxEmailsFromEnv() map[string]bool {
	return ParseSmartInboxEmails(os.Getenv("MULTICA_SMART_INBOX_EMAILS"))
}

// SmartInboxEnabledFor reports whether the smart inbox is on for this email.
func (h *Handler) SmartInboxEnabledFor(email string) bool {
	return h.SmartInboxEmails[strings.ToLower(strings.TrimSpace(email))]
}

type signalAction struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// signalReply is a one-tap answer (contango patch 18): a button that posts
// Content on the signal's own issue, as a reply to ParentCommentID (the ask)
// when set, as the clicking recipient. It has no issue of its own: a reply can
// only ever land on the signal's issue. Kept apart from actions so clients that
// predate it (whose actions parser drops the whole list on an entry without a
// url) keep their link buttons and simply never see the replies.
type signalReply struct {
	Label           string `json:"label"`
	Content         string `json:"content"`
	ParentCommentID string `json:"parent_comment_id,omitempty"`
	AskID           string `json:"ask_id,omitempty"` // contango patch 30: the ask this reply answers
}

// signalBrief is an ask in plain words (contango patch 43, inbox tabs): what is
// going on, what the agent recommends, and what happens if nobody answers.
// Optional and additive: clients that predate it ignore it.
type signalBrief struct {
	Situation string `json:"situation,omitempty"`
	Recommend string `json:"recommend,omitempty"`
	// Default: what happens with no answer, and when. Empty with
	// DefaultApplies false means nothing happens.
	Default        string `json:"default,omitempty"`
	DefaultApplies bool   `json:"default_applies,omitempty"`
	ReplyWith      string `json:"reply_with,omitempty"`
}

// signalMerge are a merge ask's facts (contango patch 43): the PR, why it needs a
// human, CI, the agents' review and size. State says whether the ask still
// stands: anything but "open" is finished (merged, queued, approved, closed)
// and the tabs view hides it on screen without archiving it. PostMerge marks a
// review of a PR that merged without its human.
type signalMerge struct {
	PR        string `json:"pr,omitempty"`
	URL       string `json:"url,omitempty"`
	ReviewURL string `json:"review_url,omitempty"`
	Risk      string `json:"risk,omitempty"`
	CI        string `json:"ci,omitempty"`
	Review    string `json:"review,omitempty"`
	Lines     int    `json:"lines,omitempty"`
	Files     int    `json:"files,omitempty"`
	State     string `json:"state,omitempty"`
	PostMerge bool   `json:"post_merge,omitempty"`
	MergedAt  string `json:"merged_at,omitempty"`
}

var signalMergeStates = map[string]bool{"": true, "open": true, "merged": true, "queued": true, "approved": true, "closed": true}

var signalCIStates = map[string]bool{"": true, "green": true, "red": true, "running": true, "unknown": true}

type signalRank struct {
	Priority string `json:"priority"`
	Blocks   int    `json:"blocks"`
	Since    string `json:"since"`
}

// signalDetails is the inbox_item.details shape of a signal. resolved_at is
// stamped by ResolveInboxSignal and never written here.
type signalDetails struct {
	Key     string         `json:"key"`
	Group   string         `json:"group"`
	Summary string         `json:"summary"`
	Actions []signalAction `json:"actions"`
	Replies []signalReply  `json:"replies,omitempty"`
	Rank    signalRank     `json:"rank"`
	Brief   *signalBrief   `json:"brief,omitempty"`
	Merge   *signalMerge   `json:"merge,omitempty"`
}

type upsertSignalRequest struct {
	RecipientMemberID string         `json:"recipient_member_id"`
	Key               string         `json:"key"`
	Group             string         `json:"group"`
	Severity          string         `json:"severity"`
	IssueID           *string        `json:"issue_id"`
	Title             string         `json:"title"`
	Summary           string         `json:"summary"`
	Body              string         `json:"body"`
	Actions           []signalAction `json:"actions"`
	Replies           []signalReply  `json:"replies"`
	Rank              struct {
		Priority string  `json:"priority"`
		Blocks   int     `json:"blocks"`
		Since    *string `json:"since"`
	} `json:"rank"`
	Push  *bool        `json:"push"`
	Brief *signalBrief `json:"brief"`
	Merge *signalMerge `json:"merge"`
}

type resolveSignalRequest struct {
	RecipientMemberID string `json:"recipient_member_id"`
	Key               string `json:"key"`
	// ArchiveRelated also archives the recipient's other entries on the
	// signal's issue created up to now (the mentions that carried the ask).
	ArchiveRelated bool `json:"archive_related"`
}

func runeLen(s string) int { return utf8.RuneCountInString(s) }

// validate normalizes defaults and returns a client-facing error message.
func (req *upsertSignalRequest) validate() string {
	req.Key = strings.TrimSpace(req.Key)
	req.Title = strings.TrimSpace(req.Title)
	req.Summary = strings.TrimSpace(req.Summary)
	req.Body = strings.TrimSpace(req.Body)
	switch {
	case req.Key == "" || runeLen(req.Key) > signalKeyMaxLen:
		return "key is required (max 200 characters)"
	case !signalGroups[req.Group]:
		return "group must be one of merge, decision, access, stalled, blocking, alert, fyi"
	case req.Title == "" || runeLen(req.Title) > signalTitleMaxLen:
		return "title is required (max 60 characters)"
	case runeLen(req.Summary) > signalSummaryMaxLen:
		return "summary is too long (max 140 characters)"
	case runeLen(req.Body) > signalBodyMaxLen:
		return "body is too long (max 600 characters)"
	case len(req.Actions) > signalMaxActions:
		return "at most 3 actions"
	case req.Rank.Blocks < 0 || req.Rank.Blocks > signalMaxBlocks:
		return "rank.blocks must be between 0 and 10000"
	}
	if req.Severity == "" {
		req.Severity = "attention"
	}
	if !signalSeverities[req.Severity] {
		return "severity must be one of action_required, attention, info"
	}
	if req.Rank.Priority == "" {
		req.Rank.Priority = "none"
	}
	if !signalPriorities[req.Rank.Priority] {
		return "rank.priority must be one of urgent, high, medium, low, none"
	}
	if req.Rank.Since != nil && *req.Rank.Since != "" {
		t, err := time.Parse(time.RFC3339, *req.Rank.Since)
		if err != nil {
			return "rank.since must be an RFC3339 timestamp"
		}
		s := t.UTC().Format(time.RFC3339)
		req.Rank.Since = &s
	}
	for i := range req.Actions {
		a := &req.Actions[i]
		a.Label = strings.TrimSpace(a.Label)
		a.URL = strings.TrimSpace(a.URL)
		if a.Label == "" || runeLen(a.Label) > signalLabelMaxLen {
			return "action label is required (max 40 characters)"
		}
		if len(a.URL) > signalURLMaxLen {
			return "action url is too long"
		}
		u, err := url.Parse(a.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return "action url must be an absolute http or https URL"
		}
	}
	if req.Actions == nil {
		req.Actions = []signalAction{}
	}
	if len(req.Replies) > signalMaxReplies {
		return "at most 2 replies"
	}
	for i := range req.Replies {
		rp := &req.Replies[i]
		rp.Label = strings.TrimSpace(rp.Label)
		rp.Content = strings.TrimSpace(sanitizeNullBytes(rp.Content))
		rp.ParentCommentID = strings.TrimSpace(rp.ParentCommentID)
		if rp.Label == "" || runeLen(rp.Label) > signalLabelMaxLen {
			return "reply label is required (max 40 characters)"
		}
		if rp.Content == "" || runeLen(rp.Content) > signalReplyMaxLen {
			return "reply content is required (max 500 characters)"
		}
		if rp.ParentCommentID != "" {
			if _, err := uuid.Parse(rp.ParentCommentID); err != nil {
				return "reply parent_comment_id must be a uuid"
			}
		}
	}
	return req.validateTabs()
}

// validateTabs checks the optional brief and merge facts (patch 43). Empty ones
// are dropped so they are stored as absent.
func (req *upsertSignalRequest) validateTabs() string {
	if b := req.Brief; b != nil {
		b.Situation = strings.TrimSpace(sanitizeNullBytes(b.Situation))
		b.Recommend = strings.TrimSpace(sanitizeNullBytes(b.Recommend))
		b.Default = strings.TrimSpace(sanitizeNullBytes(b.Default))
		b.ReplyWith = strings.TrimSpace(sanitizeNullBytes(b.ReplyWith))
		switch {
		case runeLen(b.Situation) > signalBriefMaxLen:
			return "brief.situation is too long (max 600 characters)"
		case runeLen(b.Recommend) > signalBriefLineMaxLen, runeLen(b.Default) > signalBriefLineMaxLen,
			runeLen(b.ReplyWith) > signalBriefLineMaxLen:
			return "brief.recommend, brief.default and brief.reply_with are at most 300 characters"
		}
		if b.Situation == "" && b.Recommend == "" && b.Default == "" && b.ReplyWith == "" {
			req.Brief = nil
		}
	}
	if m := req.Merge; m != nil {
		m.PR = strings.TrimSpace(m.PR)
		m.Risk = strings.TrimSpace(sanitizeNullBytes(m.Risk))
		m.Review = strings.TrimSpace(sanitizeNullBytes(m.Review))
		m.URL = strings.TrimSpace(m.URL)
		m.ReviewURL = strings.TrimSpace(m.ReviewURL)
		m.MergedAt = strings.TrimSpace(m.MergedAt)
		switch {
		case runeLen(m.PR) > signalLabelMaxLen:
			return "merge.pr is too long (max 40 characters)"
		case runeLen(m.Risk) > signalMergeTextMaxLen, runeLen(m.Review) > signalMergeTextMaxLen:
			return "merge.risk and merge.review are at most 300 characters"
		case !signalMergeStates[m.State]:
			return "merge.state must be one of open, merged, queued, approved, closed"
		case !signalCIStates[m.CI]:
			return "merge.ci must be one of green, red, running, unknown"
		case m.Lines < 0 || m.Lines > signalMergeMaxLines || m.Files < 0 || m.Files > signalMergeMaxLines:
			return "merge.lines and merge.files must be between 0 and 1000000"
		}
		for _, raw := range []string{m.URL, m.ReviewURL} {
			if raw == "" {
				continue
			}
			u, err := url.Parse(raw)
			if len(raw) > signalURLMaxLen || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				return "merge.url and merge.review_url must be absolute http or https URLs"
			}
		}
		if m.MergedAt != "" {
			t, err := time.Parse(time.RFC3339, m.MergedAt)
			if err != nil {
				return "merge.merged_at must be an RFC3339 timestamp"
			}
			m.MergedAt = t.UTC().Format(time.RFC3339)
		}
	}
	return ""
}

// signalRecipient resolves recipient_member_id — the recipient's user id
// (what inbox_item.recipient_id stores), or, as a fallback, their member row
// id — to a user who is a member of the workspace. ok=false means a response
// was already written.
func (h *Handler) signalRecipient(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID, raw string) (db.User, bool) {
	id, ok := parseUUIDOrBadRequest(w, raw, "recipient_member_id")
	if !ok {
		return db.User{}, false
	}
	var userID pgtype.UUID
	if m, err := h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{
		UserID: id, WorkspaceID: workspaceID,
	}); err == nil {
		userID = m.UserID
	} else if m, err := h.Queries.GetMember(r.Context(), id); err == nil && m.WorkspaceID == workspaceID {
		userID = m.UserID
	} else {
		writeError(w, http.StatusBadRequest, "recipient is not a member of this workspace")
		return db.User{}, false
	}
	user, err := h.Queries.GetUser(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "recipient is not a member of this workspace")
		return db.User{}, false
	}
	return user, true
}

// UpsertInboxSignal handles POST /api/inbox/signals.
func (h *Handler) UpsertInboxSignal(w http.ResponseWriter, r *http.Request) {
	var req upsertSignalRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if msg := req.validate(); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	var issueID pgtype.UUID
	if req.IssueID != nil && *req.IssueID != "" {
		id, ok := parseUUIDOrBadRequest(w, *req.IssueID, "issue_id")
		if !ok {
			return
		}
		if _, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{ID: id, WorkspaceID: wsUUID}); err != nil {
			writeError(w, http.StatusBadRequest, "issue_id is not an issue in this workspace")
			return
		}
		issueID = id
	}
	if !h.validSignalReplies(w, r, issueID, req.Replies) {
		return
	}
	recipient, ok := h.signalRecipient(w, r, wsUUID, req.RecipientMemberID)
	if !ok {
		return
	}
	if !h.SmartInboxEnabledFor(recipient.Email) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	item, created, changed, err := h.upsertSignal(r.Context(), wsUUID, recipient.ID, issueID, &req)
	if err != nil {
		slog.Warn("upsert inbox signal failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save signal")
		return
	}

	// Pushes: a new signal pushes unless the request says push:false; an
	// update pushes only on an explicit push:true with a changed title or
	// summary (a re-raise). Either way the recipient's per-group setting wins.
	wantPush := (created && (req.Push == nil || *req.Push)) || (!created && changed && req.Push != nil && *req.Push)
	if wantPush && !h.signalPushAllowed(r.Context(), workspaceID, recipient.ID, req.Group) {
		wantPush = false
	}

	resp := h.enrichInboxResponse(r.Context(), inboxToResponse(item), item.IssueID)
	itemMap := inboxResponseMap(resp)
	recipientID := uuidToString(recipient.ID)
	actorID := requestUserID(r)
	if wantPush {
		h.publish(protocol.EventInboxNew, workspaceID, "member", actorID, map[string]any{"item": itemMap})
	} else {
		h.publish(protocol.EventInboxUpdated, workspaceID, "member", actorID, map[string]any{
			"item_id": resp.ID, "recipient_id": recipientID, "item": itemMap,
		})
	}

	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"item": resp, "created": created, "pushed": wantPush})
}

// upsertSignal writes the signal in one transaction. changed reports whether
// an existing signal's title or summary differs from the request.
func (h *Handler) upsertSignal(ctx context.Context, wsID, recipientID, issueID pgtype.UUID, req *upsertSignalRequest) (db.InboxItem, bool, bool, error) {
	// Two attempts: a concurrent insert of the same key makes the first insert
	// return no row, and the retry then finds and updates that row.
	for attempt := 0; attempt < 2; attempt++ {
		item, created, changed, err := h.upsertSignalOnce(ctx, wsID, recipientID, issueID, req)
		if errors.Is(err, errSignalInsertRace) {
			continue
		}
		return item, created, changed, err
	}
	return db.InboxItem{}, false, false, errSignalInsertRace
}

var errSignalInsertRace = errors.New("concurrent signal insert")

func (h *Handler) upsertSignalOnce(ctx context.Context, wsID, recipientID, issueID pgtype.UUID, req *upsertSignalRequest) (db.InboxItem, bool, bool, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.InboxItem{}, false, false, err
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)

	existing, err := qtx.GetLiveInboxSignalForUpdate(ctx, db.GetLiveInboxSignalForUpdateParams{
		WorkspaceID: wsID, RecipientID: recipientID, SignalKey: req.Key,
	})
	found := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return db.InboxItem{}, false, false, err
	}

	details := signalDetails{
		Key: req.Key, Group: req.Group, Summary: req.Summary, Actions: req.Actions, Replies: req.Replies,
		Rank:  signalRank{Priority: req.Rank.Priority, Blocks: req.Rank.Blocks},
		Brief: req.Brief, Merge: req.Merge,
	}
	var prev signalDetails
	if found {
		_ = json.Unmarshal(existing.Details, &prev)
	}
	switch {
	case req.Rank.Since != nil && *req.Rank.Since != "":
		details.Rank.Since = *req.Rank.Since
	case found && prev.Rank.Since != "":
		details.Rank.Since = prev.Rank.Since
	default:
		details.Rank.Since = time.Now().UTC().Format(time.RFC3339)
	}
	detailsJSON, err := json.Marshal(details)
	if err != nil {
		return db.InboxItem{}, false, false, err
	}
	body := pgtype.Text{String: req.Body, Valid: req.Body != ""}

	if !found {
		item, err := qtx.InsertInboxSignal(ctx, db.InsertInboxSignalParams{
			ID: dbid.NewV7(), WorkspaceID: wsID, RecipientID: recipientID, Severity: req.Severity,
			IssueID: issueID, Title: req.Title, Body: body, Details: detailsJSON,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return db.InboxItem{}, false, false, errSignalInsertRace
		}
		if err != nil {
			return db.InboxItem{}, false, false, err
		}
		return item, true, false, tx.Commit(ctx)
	}

	changed := existing.Title != req.Title || prev.Summary != req.Summary
	reraise := changed && req.Push != nil && *req.Push
	item, err := qtx.UpdateInboxSignal(ctx, db.UpdateInboxSignalParams{
		ID: existing.ID, Severity: req.Severity, IssueID: issueID, Title: req.Title, Body: body,
		Details: detailsJSON, Reraise: reraise,
	})
	if err != nil {
		return db.InboxItem{}, false, false, err
	}
	return item, false, changed, tx.Commit(ctx)
}

func (h *Handler) signalPushAllowed(ctx context.Context, workspaceID string, userID pgtype.UUID, group string) bool {
	prefs := map[string]string{}
	pref, err := h.Queries.GetNotificationPreference(ctx, db.GetNotificationPreferenceParams{
		WorkspaceID: parseUUID(workspaceID), UserID: userID,
	})
	if err == nil {
		_ = json.Unmarshal(pref.Preferences, &prefs)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("signal push: load notification preferences failed", "error", err)
	}
	return signalPushEnabled(prefs, group)
}

// ResolveInboxSignal handles POST /api/inbox/signals/resolve: archive the
// live signal for the key, without a push. Unknown keys answer 204.
func (h *Handler) ResolveInboxSignal(w http.ResponseWriter, r *http.Request) {
	var req resolveSignalRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Key = strings.TrimSpace(req.Key)
	if req.Key == "" || runeLen(req.Key) > signalKeyMaxLen {
		writeError(w, http.StatusBadRequest, "key is required (max 200 characters)")
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	recipient, ok := h.signalRecipient(w, r, wsUUID, req.RecipientMemberID)
	if !ok {
		return
	}
	if !h.SmartInboxEnabledFor(recipient.Email) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	item, err := h.Queries.ResolveInboxSignal(r.Context(), db.ResolveInboxSignalParams{
		WorkspaceID: wsUUID, RecipientID: recipient.ID, SignalKey: req.Key,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		slog.Warn("resolve inbox signal failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to resolve signal")
		return
	}
	h.publish(protocol.EventInboxArchived, workspaceID, "member", requestUserID(r), map[string]any{
		"item_id":      uuidToString(item.ID),
		"issue_id":     uuidToPtr(item.IssueID),
		"recipient_id": uuidToString(item.RecipientID),
	})
	var related int64
	if req.ArchiveRelated && item.IssueID.Valid {
		related, err = h.Queries.ArchiveInboxRelatedToSignal(r.Context(), db.ArchiveInboxRelatedToSignalParams{
			WorkspaceID: wsUUID, RecipientID: recipient.ID, IssueID: item.IssueID,
		})
		if err != nil {
			// The signal itself is resolved; report the partial result.
			slog.Warn("archive entries related to signal failed", append(logger.RequestAttrs(r), "error", err)...)
		} else if related > 0 {
			h.publish(protocol.EventInboxBatchArchived, workspaceID, "member", requestUserID(r), map[string]any{
				"recipient_id": uuidToString(item.RecipientID),
				"count":        related,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": inboxToResponse(item), "archived_related": related})
}

// inboxResponseMap converts a response to the map shape the inbox:new
// listeners (realtime fan-out, WeCom) type-assert on.
func inboxResponseMap(resp InboxItemResponse) map[string]any {
	raw, err := json.Marshal(resp)
	if err != nil {
		return map[string]any{}
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	return out
}
