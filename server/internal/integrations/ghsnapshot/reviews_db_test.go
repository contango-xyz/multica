package ghsnapshot

import (
	"context"
	"testing"
	"time"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// The snapshot refresh backfills reviews (contango) in the same guarded write.
func TestApplySnapshotBackfillsReviews(t *testing.T) {
	pool := testDBPool(t)
	q := db.New(pool)
	ctx := context.Background()
	now := time.Unix(1_700_000_300, 0)

	pr := seedPR(t, pool, q, "H")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM github_pull_request_review WHERE pull_request_id=$1`, pr.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM github_pull_request_check_run WHERE pr_id=$1`, pr.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM github_pull_request WHERE id=$1`, pr.ID)
	})
	m := &Manager{queries: q, pool: pool, now: func() time.Time { return now }}
	submitted := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	states := func() map[int64]string {
		rows, err := q.ListGitHubPRReviews(ctx, pr.ID)
		if err != nil {
			t.Fatal(err)
		}
		out := map[int64]string{}
		for _, r := range rows {
			out[r.GithubReviewID] = r.State
		}
		return out
	}

	snap := &PRSnapshot{HeadSHA: "H", Mergeable: "MERGEABLE", MergeStateStatus: "CLEAN", ReviewsFetched: true, Reviews: []Review{
		{ID: 1, Login: "owner", UserType: "User", State: "APPROVED", CommitID: "H", SubmittedAt: submitted},
		{ID: 2, Login: "greptile", UserType: "Bot", State: "COMMENTED"},
	}}
	if applied, err := m.applySnapshot(ctx, pr.ID, snap); err != nil || !applied {
		t.Fatalf("applied=%v err=%v", applied, err)
	}
	if got := states(); len(got) != 2 || got[1] != "APPROVED" || got[2] != "COMMENTED" {
		t.Fatalf("after backfill: %v", got)
	}

	// Re-applying is idempotent; a stale response for an older head writes nothing.
	if _, err := m.applySnapshot(ctx, pr.ID, snap); err != nil {
		t.Fatal(err)
	}
	stale := &PRSnapshot{HeadSHA: "OLD", ReviewsFetched: true, Reviews: []Review{{ID: 3, Login: "x", UserType: "User", State: "APPROVED"}}}
	if applied, _ := m.applySnapshot(ctx, pr.ID, stale); applied {
		t.Fatal("stale head applied")
	}
	if got := states(); len(got) != 2 {
		t.Fatalf("after re-apply and stale: %v", got)
	}

	// A failed reviews call leaves stored reviews alone.
	if _, err := m.applySnapshot(ctx, pr.ID, &PRSnapshot{HeadSHA: "H", Mergeable: "MERGEABLE", MergeStateStatus: "CLEAN"}); err != nil {
		t.Fatal(err)
	}
	if got := states(); len(got) != 2 {
		t.Fatalf("after unfetched reviews: %v", got)
	}

	// A dismissal is final: an older backfill listing the review as approved
	// does not revive it.
	if err := UpsertReviews(ctx, q, pr.ID, []Review{{ID: 1, Login: "owner", UserType: "User", State: "DISMISSED"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.applySnapshot(ctx, pr.ID, snap); err != nil {
		t.Fatal(err)
	}
	if got := states(); got[1] != "DISMISSED" {
		t.Fatalf("dismissal reverted: %v", got)
	}
}

func TestNormalizeReviewState(t *testing.T) {
	for in, want := range map[string]string{
		"approved": "APPROVED", "CHANGES_REQUESTED": "CHANGES_REQUESTED", "commented": "COMMENTED", "dismissed": "DISMISSED",
	} {
		if got, ok := NormalizeReviewState(in); !ok || got != want {
			t.Fatalf("%s -> %s %v", in, got, ok)
		}
	}
	for _, in := range []string{"PENDING", "", "weird"} {
		if _, ok := NormalizeReviewState(in); ok {
			t.Fatalf("%q should be skipped", in)
		}
	}
}
