package handler

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// sendGitHubWebhook signs and delivers one webhook to the handler.
func sendGitHubWebhook(t *testing.T, secret, event string, body map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(raw)
	req := httptest.NewRequest("POST", "/api/webhooks/github", bytes.NewReader(raw))
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	testutil.Call(t, testHandler.HandleGitHubWebhook, req).Want(http.StatusAccepted)
}

func TestWebhookPullRequestReviewsAreStored(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	const secret = "review-test-secret"
	t.Setenv("GITHUB_WEBHOOK_SECRET", secret)

	ws := dbfx.Workspace(t, "Reviews", "reviews-"+uuid.NewString()[:8])
	installationID := int64(77000000) + int64(uuid.New().ID()%1_000_000)
	if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
		WorkspaceID: parseUUID(ws), InstallationID: installationID, AccountLogin: "acme", AccountType: "Organization",
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_pull_request_review WHERE pull_request_id IN (SELECT id FROM github_pull_request WHERE workspace_id = $1)`, ws)
		testPool.Exec(ctx, `DELETE FROM github_pull_request WHERE workspace_id = $1`, ws)
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE workspace_id = $1`, ws)
	})
	repo := map[string]any{"name": "widget", "owner": map[string]any{"login": "acme"}}
	inst := map[string]any{"id": installationID}

	review := func(action string, id int64, state string) map[string]any {
		return map[string]any{
			"action": action,
			"review": map[string]any{
				"id": id, "state": state, "commit_id": "abc123", "submitted_at": "2026-11-03T10:00:00Z",
				"user": map[string]any{"login": "owner", "type": "User"},
			},
			"pull_request": map[string]any{"number": 42},
			"repository":   repo, "installation": inst,
		}
	}

	// A review on a PR that isn't mirrored yet is skipped (the refresh backfills it).
	sendGitHubWebhook(t, secret, "pull_request_review", review("submitted", 900, "approved"))

	sendGitHubWebhook(t, secret, "pull_request", map[string]any{
		"action": "opened",
		"pull_request": map[string]any{
			"number": 42, "html_url": "https://github.com/acme/widget/pull/42", "title": "Widget", "body": "",
			"state": "open", "draft": false, "merged": false, "created_at": "2026-11-03T09:00:00Z",
			"updated_at": "2026-11-03T09:00:00Z", "head": map[string]any{"ref": "w", "sha": "abc123"},
			"user": map[string]any{"login": "dev", "avatar_url": ""},
		},
		"repository": repo, "installation": inst,
	})
	pr, err := testHandler.Queries.GetGitHubPullRequest(ctx, db.GetGitHubPullRequestParams{
		WorkspaceID: parseUUID(ws), RepoOwner: "acme", RepoName: "widget", PrNumber: 42,
	})
	if err != nil {
		t.Fatalf("PR not mirrored: %v", err)
	}
	reviews := func() []db.GithubPullRequestReview {
		rows, err := testHandler.Queries.ListGitHubPRReviews(ctx, pr.ID)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	if got := reviews(); len(got) != 0 {
		t.Fatalf("review before mirror was stored: %+v", got)
	}

	// Submitted, then the same delivery again: one row.
	sendGitHubWebhook(t, secret, "pull_request_review", review("submitted", 901, "approved"))
	sendGitHubWebhook(t, secret, "pull_request_review", review("submitted", 901, "approved"))
	got := reviews()
	if len(got) != 1 || got[0].GithubReviewID != 901 || got[0].State != "APPROVED" || got[0].ReviewerLogin != "owner" ||
		got[0].ReviewerType != "User" || got[0].CommitID.String != "abc123" || !got[0].SubmittedAt.Valid {
		t.Fatalf("after submitted twice: %+v", got)
	}

	// A bot's comment review and a pending review (never stored).
	bot := review("submitted", 902, "commented")
	bot["review"].(map[string]any)["user"] = map[string]any{"login": "greptile[bot]", "type": "Bot"}
	sendGitHubWebhook(t, secret, "pull_request_review", bot)
	sendGitHubWebhook(t, secret, "pull_request_review", review("submitted", 903, "pending"))
	if got := reviews(); len(got) != 2 || got[1].ReviewerType != "Bot" || got[1].State != "COMMENTED" {
		t.Fatalf("bot + pending: %+v", got)
	}

	// Dismissed: the state changes, and a late "submitted" replay does not revive it.
	sendGitHubWebhook(t, secret, "pull_request_review", review("dismissed", 901, "dismissed"))
	sendGitHubWebhook(t, secret, "pull_request_review", review("submitted", 901, "approved"))
	if got := reviews(); got[0].GithubReviewID != 901 || got[0].State != "DISMISSED" {
		t.Fatalf("after dismissal: %+v", got)
	}

	// Edited keeps one row and takes the new state.
	sendGitHubWebhook(t, secret, "pull_request_review", review("edited", 902, "commented"))
	if got := reviews(); len(got) != 2 {
		t.Fatalf("after edit: %+v", got)
	}
}
