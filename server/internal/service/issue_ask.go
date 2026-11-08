package service

// Asks as real objects (contango patch 30, docs/contango/PATCHES.md). An ask
// is a [NEEDS HUMAN] or [NEEDS OPERATOR] comment plus an issue_ask row written
// with it, so "is it answered" is a stored fact rather than something each ops
// script infers from who commented next. The comment keeps today's format
// exactly: the 13 scripts that parse it keep working unchanged.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

const (
	AskKindMerge     = "merge"
	AskKindDecision  = "decision"
	AskKindAccess    = "access"
	AskKindAdmission = "admission"
	AskKindTechOwner = "tech_owner"
	AskKindOperator  = "operator"

	AskStateOpen      = "open"
	AskStateAnswered  = "answered"
	AskStateWithdrawn = "withdrawn"

	AskViaOneTap         = "one_tap"
	AskViaComment        = "comment"
	AskViaStatusMove     = "status_move"
	AskViaPRApproved     = "pr_approved"
	AskViaDefaultApplied = "default_applied"
	AskViaOps            = "ops"

	AskAddresseeMember = "member"
	AskAddresseeAgent  = "agent"
	AskAddresseeRole   = "role"
	AskRoleOperator    = "operator"

	askSourceCLI = "cli"
	askMaxOpts   = 8

	AskWithdrawnCardClosed    = "card closed"
	AskWithdrawnCommentGone   = "ask comment deleted"
	askDefaultNoAnswerNoGiven = "no default given"
)

// AsksEnabled is the off switch: MULTICA_ASKS=0 refuses the routes and turns
// the hooks into no-ops, and markers carry on as before. Read on each call so
// tests and a recreated container pick up changes.
func AsksEnabled() bool { return os.Getenv("MULTICA_ASKS") != "0" }

var errNoOpenAsk = errors.New("no open ask")

// AskInputError is a request the caller can correct (HTTP 400).
type AskInputError struct{ Msg string }

func (e *AskInputError) Error() string { return e.Msg }

func askInputErr(format string, args ...any) error {
	return &AskInputError{Msg: fmt.Sprintf(format, args...)}
}

// IssueAskOption is one accepted reply: Label is what a button shows, Reply is
// the literal text that goes into the Reply with line and gets posted.
type IssueAskOption struct {
	Label string `json:"label"`
	Reply string `json:"reply"`
}

// IssueAskInput is a create request. The structured fields land on the row;
// the prose fields (Where through Fix) only render into the comment.
type IssueAskInput struct {
	AddresseeType string           `json:"addressee_type"`
	AddresseeID   string           `json:"addressee_id"`
	AddresseeRole string           `json:"addressee_role"`
	Kind          string           `json:"kind"`
	Topic         string           `json:"topic"`
	Options       []IssueAskOption `json:"options"`
	Recommended   string           `json:"recommended"`
	DefaultOption string           `json:"default_option"`
	Reversible    bool             `json:"reversible"`
	ExpiresAt     *time.Time       `json:"expires_at"`
	PRID          string           `json:"pr_id"`
	ParentID      string           `json:"parent_id"`

	Where           string `json:"where"`
	WhyAsked        string `json:"why_asked"`
	RecommendReason string `json:"recommend_reason"`
	Approving       string `json:"approving"`
	Risk            string `json:"risk"`
	Links           string `json:"links"`
	DefaultWhy      string `json:"default_why"`
	// Tech marks a technical ask ([TECH] after the tag).
	Tech      bool   `json:"tech"`
	LastLine  string `json:"last_line"`
	Diagnosis string `json:"diagnosis"`
	Fix       string `json:"fix"`
}

// oneLine makes a prose field a single line: the scripts read each field with
// a `(.+)` that stops at the first newline, so a multi-line value would be cut
// off for them.
func oneLine(s string) string {
	return strings.TrimSpace(newlines.ReplaceAllString(s, " "))
}

var newlines = regexp.MustCompile(`[\r\n]+`)

// Normalize validates the request in place and returns an *AskInputError for
// anything the caller can fix.
func (in *IssueAskInput) Normalize() error {
	in.Topic = strings.TrimSpace(in.Topic)
	if in.Topic == "" {
		return askInputErr("topic is required")
	}
	if strings.ContainsAny(in.Topic, "\r\n") {
		return askInputErr("topic must be one line")
	}
	switch in.Kind {
	case AskKindMerge, AskKindDecision, AskKindAccess, AskKindAdmission, AskKindTechOwner, AskKindOperator:
	default:
		return askInputErr("kind must be one of merge, decision, access, admission, tech_owner, operator")
	}

	switch in.AddresseeType {
	case AskAddresseeRole:
		if in.AddresseeRole != AskRoleOperator {
			return askInputErr("addressee_role must be operator")
		}
		if in.Kind != AskKindOperator {
			return askInputErr("an ask to the operator must have kind operator")
		}
	case AskAddresseeMember:
		if in.Kind == AskKindOperator {
			return askInputErr("kind operator needs the operator as addressee")
		}
		if len(in.Options) == 0 {
			return askInputErr("an ask to a person needs at least one reply option")
		}
	case AskAddresseeAgent:
		// issue_ask can hold it, but there is no marker for it: an agent ask
		// would render as [NEEDS HUMAN] and page a person, and the agent-to-agent
		// markers stay comments for now.
		return askInputErr("asks addressed to an agent are not supported yet; use the agent-to-agent markers")
	default:
		return askInputErr("addressee_type must be member or role")
	}

	if len(in.Options) > askMaxOpts {
		return askInputErr("at most %d reply options", askMaxOpts)
	}
	seen := make(map[string]bool, len(in.Options))
	for i := range in.Options {
		o := &in.Options[i]
		o.Reply = strings.TrimSpace(o.Reply)
		o.Label = strings.TrimSpace(o.Label)
		if o.Reply == "" {
			return askInputErr("reply option %d is empty", i+1)
		}
		if strings.ContainsAny(o.Reply, "`\r\n") {
			return askInputErr("reply %q must be one line without backticks", o.Reply)
		}
		if seen[o.Reply] {
			return askInputErr("reply %q is listed twice", o.Reply)
		}
		seen[o.Reply] = true
		if o.Label == "" {
			o.Label = o.Reply
		}
	}

	in.Recommended = strings.TrimSpace(in.Recommended)
	if in.Recommended != "" && !seen[in.Recommended] {
		return askInputErr("recommended %q is not one of the replies", in.Recommended)
	}
	in.DefaultOption = strings.TrimSpace(in.DefaultOption)
	if in.DefaultOption != "" {
		if in.Kind != AskKindDecision {
			return askInputErr("only a decision ask can have a default")
		}
		if !seen[in.DefaultOption] {
			return askInputErr("default %q is not one of the replies", in.DefaultOption)
		}
		if !in.Reversible {
			return askInputErr("a default needs --reversible; an irreversible ask waits for its answer")
		}
	} else if in.Reversible {
		return askInputErr("--reversible needs a default")
	}

	if in.ExpiresAt != nil && !in.ExpiresAt.After(time.Now()) {
		return askInputErr("expires_at must be in the future")
	}
	for _, f := range []*string{&in.Where, &in.WhyAsked, &in.RecommendReason, &in.Approving, &in.Risk, &in.Links, &in.DefaultWhy, &in.LastLine, &in.Diagnosis, &in.Fix} {
		*f = oneLine(*f)
	}
	return nil
}

// RenderAskComment writes the ask in the format agents post today (the
// scrum-master and pm-ovh role prompts; live examples in the patch notes).
// The scripts anchor on this text: the bold tag at the start, one **Field:**
// per line, the Reply with line as `code` spans, and a default line whose
// parenthesis is exactly "reversible" when a default applies. handle is the
// addressee's mention text for a member ask.
func RenderAskComment(in IssueAskInput, handle string) string {
	if in.AddresseeType == AskAddresseeRole {
		return joinAskBlocks(
			"**[NEEDS OPERATOR]** "+in.Topic,
			askField("Last line", in.LastLine),
			askField("Diagnosis", in.Diagnosis),
			askField("Suggested fix", in.Fix),
			askField("Links", in.Links),
		)
	}

	head := "**[NEEDS HUMAN]** "
	switch {
	case in.Kind == AskKindTechOwner:
		head += "[TECH OWNER] "
	case in.Tech:
		head += "[TECH] "
	}
	replies := make([]string, 0, len(in.Options))
	for _, o := range in.Options {
		replies = append(replies, "`"+o.Reply+"`")
	}
	recommend := in.RecommendReason
	if in.Recommended != "" {
		recommend = "`" + in.Recommended + "`"
		if in.RecommendReason != "" {
			recommend += ": " + in.RecommendReason
		}
	}
	return joinAskBlocks(
		head+in.Topic,
		askField("Where we are", in.Where),
		askField("Why you're asked", in.WhyAsked),
		askField("Reply with", strings.Join(replies, " / ")),
		askField("I recommend", recommend),
		"---",
		askField("What you are approving", in.Approving),
		askField("Risk", in.Risk),
		askField("Default if no answer", askDefaultLine(in)),
		askField("Links", in.Links),
		fmt.Sprintf("[@%s](mention://member/%s)", handle, in.AddresseeID),
	)
}

func askDefaultLine(in IssueAskInput) string {
	if in.DefaultOption != "" {
		return "`" + in.DefaultOption + "` (reversible)"
	}
	why := in.DefaultWhy
	if why == "" {
		why = in.Kind
		if in.Kind == AskKindDecision {
			why = askDefaultNoAnswerNoGiven
		}
	}
	return "none (irreversible: " + why + ")"
}

func askField(name, value string) string {
	if value == "" {
		return ""
	}
	return "**" + name + ":** " + value
}

func joinAskBlocks(blocks ...string) string {
	kept := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b != "" {
			kept = append(kept, b)
		}
	}
	return strings.Join(kept, "\n\n")
}

// CreateAskForComment writes the row in the comment's transaction. The author
// and task come from the stored comment, so an ask can never claim a different
// author than its comment.
func CreateAskForComment(ctx context.Context, q *db.Queries, in IssueAskInput, c db.Comment) (db.IssueAsk, error) {
	options, err := json.Marshal(in.Options)
	if err != nil {
		return db.IssueAsk{}, err
	}
	if in.Options == nil {
		options = []byte("[]")
	}
	var addresseeID, prID pgtype.UUID
	if in.AddresseeID != "" {
		if addresseeID, err = util.ParseUUID(in.AddresseeID); err != nil {
			return db.IssueAsk{}, err
		}
	}
	if in.PRID != "" {
		if prID, err = util.ParseUUID(in.PRID); err != nil {
			return db.IssueAsk{}, err
		}
	}
	var expires pgtype.Timestamptz
	if in.ExpiresAt != nil {
		expires = pgtype.Timestamptz{Time: *in.ExpiresAt, Valid: true}
	}
	return q.CreateIssueAsk(ctx, db.CreateIssueAskParams{
		ID:            dbid.NewV7(),
		WorkspaceID:   c.WorkspaceID,
		IssueID:       c.IssueID,
		CommentID:     c.ID,
		TaskID:        c.SourceTaskID,
		PrID:          prID,
		AuthorType:    c.AuthorType,
		AuthorID:      c.AuthorID,
		AddresseeType: in.AddresseeType,
		AddresseeID:   addresseeID,
		AddresseeRole: optText(in.AddresseeRole),
		Kind:          in.Kind,
		Topic:         in.Topic,
		Options:       options,
		Recommended:   optText(in.Recommended),
		DefaultOption: optText(in.DefaultOption),
		Reversible:    in.Reversible,
		ExpiresAt:     expires,
		Source:        askSourceCLI,
	})
}

func optText(s string) pgtype.Text {
	if s == "" {
		return pgtype.Text{}
	}
	return util.StrToText(s)
}

// AskAnswer is who answered and how.
type AskAnswer struct {
	AskID     pgtype.UUID
	Workspace pgtype.UUID
	Text      string
	CommentID pgtype.UUID
	ByType    string
	By        pgtype.UUID
	Via       string
}

// AnswerAsk compare-and-sets an open ask to answered. errNoOpenAsk (see
// IsNoOpenAsk) means it was no longer open.
func AnswerAsk(ctx context.Context, q *db.Queries, a AskAnswer) (db.IssueAsk, error) {
	ask, err := q.AnswerIssueAsk(ctx, db.AnswerIssueAskParams{
		AnswerText: optText(a.Text), AnswerCommentID: a.CommentID, AnsweredByType: util.StrToText(a.ByType),
		AnsweredBy: a.By, AnsweredVia: util.StrToText(a.Via), ID: a.AskID, WorkspaceID: a.Workspace,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.IssueAsk{}, errNoOpenAsk
	}
	return ask, err
}

// IsNoOpenAsk reports the "already closed" result of AnswerAsk and WithdrawAsk.
func IsNoOpenAsk(err error) bool { return errors.Is(err, errNoOpenAsk) }

// WithdrawAsk closes an open ask without an answer.
func WithdrawAsk(ctx context.Context, q *db.Queries, id, workspace pgtype.UUID, reason, byType string, by pgtype.UUID) (db.IssueAsk, error) {
	ask, err := q.WithdrawIssueAsk(ctx, db.WithdrawIssueAskParams{
		AnswerText: optText(reason), AnsweredByType: util.StrToText(byType), AnsweredBy: by, ID: id, WorkspaceID: workspace,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.IssueAsk{}, errNoOpenAsk
	}
	return ask, err
}

// WithdrawOpenAsksOnClose ends a closed card's open asks: the question died
// with the card. Called in the transaction that wrote the status.
func WithdrawOpenAsksOnClose(ctx context.Context, q *db.Queries, issue db.Issue) error {
	if !AsksEnabled() {
		return nil
	}
	_, err := q.WithdrawOpenIssueAsksByIssue(ctx, db.WithdrawOpenIssueAsksByIssueParams{
		AnswerText: util.StrToText(AskWithdrawnCardClosed), IssueID: issue.ID, WorkspaceID: issue.WorkspaceID,
	})
	return err
}

// WithdrawAskOnCommentDelete closes the ask whose comment is being deleted, so
// it cannot stay open with nothing left to read or reply to.
func WithdrawAskOnCommentDelete(ctx context.Context, q *db.Queries, commentID, workspace pgtype.UUID) error {
	if !AsksEnabled() {
		return nil
	}
	_, err := q.WithdrawOpenIssueAskByComment(ctx, db.WithdrawOpenIssueAskByCommentParams{
		AnswerText: util.StrToText(AskWithdrawnCommentGone), CommentID: commentID, WorkspaceID: workspace,
	})
	return err
}

// askForThreadReply picks which of the issue's open asks a person's reply
// answers, if any (owner: a reply in the ask's own thread answers it, any other
// comment leaves it open). An ask the reply sits under wins, nearest first.
// Otherwise the newest open ask in the same thread: the web reply box posts
// under the thread root, so a reply to an ask that is itself a reply arrives as
// its sibling. A person's own ask is never answered by their own reply.
func askForThreadReply(ctx context.Context, q *db.Queries, reply db.Comment) (db.IssueAsk, bool, error) {
	open, err := q.ListIssueAsks(ctx, db.ListIssueAsksParams{
		IssueID: reply.IssueID, WorkspaceID: reply.WorkspaceID, State: util.StrToText(AskStateOpen), RowLimit: 100,
	})
	if err != nil || len(open) == 0 {
		return db.IssueAsk{}, false, err
	}
	candidates := open[:0]
	for _, a := range open {
		if a.AuthorType == "member" && a.AuthorID == reply.AuthorID {
			continue
		}
		candidates = append(candidates, a)
	}
	if len(candidates) == 0 {
		return db.IssueAsk{}, false, nil
	}
	chain, err := q.ListCommentAncestorIDs(ctx, db.ListCommentAncestorIDsParams{CommentID: reply.ParentID, WorkspaceID: reply.WorkspaceID})
	if err != nil || len(chain) == 0 {
		return db.IssueAsk{}, false, err
	}
	for _, id := range chain {
		for _, a := range candidates {
			if a.CommentID == id {
				return a, true, nil
			}
		}
	}
	root := chain[len(chain)-1]
	for i := len(candidates) - 1; i >= 0; i-- {
		askRoot, err := q.GetThreadRoot(ctx, db.GetThreadRootParams{CommentID: candidates[i].CommentID, WorkspaceID: reply.WorkspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return db.IssueAsk{}, false, err
		}
		if askRoot.ID == root {
			return candidates[i], true, nil
		}
	}
	return db.IssueAsk{}, false, nil
}

// AnswerAskFromThreadReply records a person's reply as the answer to the ask in
// its thread. The reply is already saved; finding no open ask is the usual case.
func AnswerAskFromThreadReply(ctx context.Context, q *db.Queries, reply db.Comment) error {
	if !reply.ParentID.Valid {
		return nil
	}
	ask, found, err := askForThreadReply(ctx, q, reply)
	if err != nil || !found {
		return err
	}
	_, err = AnswerAsk(ctx, q, AskAnswer{
		AskID: ask.ID, Workspace: ask.WorkspaceID, Text: reply.Content, CommentID: reply.ID,
		ByType: "member", By: reply.AuthorID, Via: AskViaComment,
	})
	if IsNoOpenAsk(err) {
		return nil
	}
	return err
}

// AnswerAskFromOneTap records a one-tap reply as the answer to askID. The ask
// must be on the reply's own issue: the id arrived in a signal's details.
func AnswerAskFromOneTap(ctx context.Context, q *db.Queries, askID pgtype.UUID, reply db.Comment) error {
	ask, err := q.GetIssueAsk(ctx, db.GetIssueAskParams{ID: askID, WorkspaceID: reply.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("ask %s not found", util.UUIDToString(askID))
	}
	if err != nil {
		return err
	}
	if ask.IssueID != reply.IssueID {
		return fmt.Errorf("ask %s is not on the reply's issue", util.UUIDToString(askID))
	}
	_, err = AnswerAsk(ctx, q, AskAnswer{
		AskID: ask.ID, Workspace: ask.WorkspaceID, Text: reply.Content, CommentID: reply.ID,
		ByType: "member", By: reply.AuthorID, Via: AskViaOneTap,
	})
	if IsNoOpenAsk(err) {
		return nil
	}
	return err
}
