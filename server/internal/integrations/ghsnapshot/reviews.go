package ghsnapshot

// GitHub pull request reviews (contango, docs/contango/PATCHES.md). Stored from
// the pull_request_review webhook and backfilled by the snapshot refresh, so a
// PR that already had reviews before the webhook was handled is covered too.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Review is one GitHub pull request review, normalized.
type Review struct {
	ID          int64
	Login       string
	UserType    string // "User" or "Bot"
	State       string // APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED
	CommitID    string
	SubmittedAt time.Time // zero when unknown
}

// NormalizeReviewState maps GitHub's review state (webhooks send lowercase,
// REST uppercase) to the stored enum. Pending (unsubmitted) reviews and
// unknown states report ok=false and are not stored.
func NormalizeReviewState(state string) (string, bool) {
	switch s := strings.ToUpper(strings.TrimSpace(state)); s {
	case "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED":
		return s, true
	default:
		return "", false
	}
}

type restReview struct {
	ID   int64 `json:"id"`
	User *struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"user"`
	State       string     `json:"state"`
	CommitID    string     `json:"commit_id"`
	SubmittedAt *time.Time `json:"submitted_at"`
}

// reviewFromREST normalizes a REST/webhook review object. ok=false for a
// review that is not stored (pending, deleted user, malformed).
func reviewFromREST(r restReview) (Review, bool) {
	state, ok := NormalizeReviewState(r.State)
	if !ok || r.ID <= 0 || r.User == nil || r.User.Login == "" {
		return Review{}, false
	}
	out := Review{ID: r.ID, Login: r.User.Login, UserType: r.User.Type, State: state, CommitID: r.CommitID}
	if out.UserType == "" {
		out.UserType = "User"
	}
	if r.SubmittedAt != nil {
		out.SubmittedAt = *r.SubmittedAt
	}
	return out, true
}

// ReviewFromWebhook normalizes the `review` object of a pull_request_review
// webhook payload.
func ReviewFromWebhook(id int64, login, userType, state, commitID string, submittedAt *time.Time) (Review, bool) {
	r := restReview{ID: id, State: state, CommitID: commitID, SubmittedAt: submittedAt}
	if login != "" {
		r.User = &struct {
			Login string `json:"login"`
			Type  string `json:"type"`
		}{Login: login, Type: userType}
	}
	return reviewFromREST(r)
}

// FetchPRReviews lists a PR's submitted reviews (REST, Pull requests read).
func FetchPRReviews(ctx context.Context, c *Client, installationID int64, owner, repo string, number int32) ([]Review, error) {
	if !c.Enabled() {
		return nil, errors.New("ghsnapshot: client not configured")
	}
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", url.PathEscape(owner), url.PathEscape(repo), number)
	raw, err := fetchArrayPages[restReview](ctx, c, installationID, path)
	if err != nil {
		return nil, err
	}
	out := make([]Review, 0, len(raw))
	for _, r := range raw {
		if rv, ok := reviewFromREST(r); ok {
			out = append(out, rv)
		}
	}
	return out, nil
}

// reviewStore is the slice of *db.Queries the upsert needs (tx or pool).
type reviewStore interface {
	UpsertGitHubPRReview(ctx context.Context, arg db.UpsertGitHubPRReviewParams) error
}

// UpsertReviews writes reviews for one mirrored PR row. Idempotent; a stored
// dismissal is never reverted (see UpsertGitHubPRReview).
func UpsertReviews(ctx context.Context, q reviewStore, prID pgtype.UUID, reviews []Review) error {
	for _, r := range reviews {
		submitted := pgtype.Timestamptz{}
		if !r.SubmittedAt.IsZero() {
			submitted = pgtype.Timestamptz{Time: r.SubmittedAt, Valid: true}
		}
		if err := q.UpsertGitHubPRReview(ctx, db.UpsertGitHubPRReviewParams{
			PullRequestID:  prID,
			GithubReviewID: r.ID,
			ReviewerLogin:  r.Login,
			ReviewerType:   r.UserType,
			State:          r.State,
			CommitID:       textOrNull(r.CommitID),
			SubmittedAt:    submitted,
		}); err != nil {
			return err
		}
	}
	return nil
}

// maxReviewPages caps the reviews walk (100 per page).
const maxReviewPages = 30

// fetchArrayPages walks a plain-array REST collection (no total_count) until a
// short page. Like fetchSnapshotPages it never follows Link headers, so the
// installation token only ever goes to the API host.
func fetchArrayPages[T any](ctx context.Context, c *Client, installationID int64, path string) ([]T, error) {
	var items []T
	for page := 1; page <= maxReviewPages; page++ {
		data, err := c.restGet(ctx, installationID, fmt.Sprintf("%s?per_page=%d&page=%d", path, snapshotPageSize, page))
		if err != nil {
			return nil, err
		}
		var entries []T
		if json.Unmarshal(data, &entries) != nil || entries == nil || len(entries) > snapshotPageSize {
			return nil, errors.New("ghsnapshot: malformed review page")
		}
		items = append(items, entries...)
		if len(entries) < snapshotPageSize {
			return items, nil
		}
	}
	return nil, errors.New("ghsnapshot: review pagination exceeds page limit")
}
