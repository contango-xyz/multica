package push

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func testQueries(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Skip("database not available")
	}
	t.Cleanup(pool.Close)
	return db.New(pool), pool
}

func TestDBStoreDevicesAndPrefs(t *testing.T) {
	q, pool := testQueries(t)
	ctx := context.Background()
	var userID, wsID string
	if err := pool.QueryRow(ctx, `INSERT INTO "user" (name, email) VALUES ('push-store-test', 'push-store-test@example.test')
		ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id::text`).Scan(&userID); err != nil {
		t.Fatalf("user fixture: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Push Store Test', 'push-store-test', 'PST')
		ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id::text`).Scan(&wsID); err != nil {
		t.Fatalf("workspace fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, wsID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, userID)
	})
	_, _ = pool.Exec(ctx, `DELETE FROM push_device WHERE token = 'store-test'`)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM push_device WHERE token = 'store-test'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM notification_preference WHERE workspace_id = $1 AND user_id = $2`, wsID, userID)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO push_device (user_id, platform, token, bundle_id, environment) VALUES ($1,'ios','store-test','b','sandbox')`, userID); err != nil {
		t.Fatal(err)
	}
	s := NewDBStore(q)
	devs, err := s.ListEnabledDevices(ctx, userID)
	if err != nil || len(devs) == 0 {
		t.Fatalf("devices=%v err=%v", devs, err)
	}
	if err := s.DisableToken(ctx, "store-test"); err != nil {
		t.Fatal(err)
	}
	devs, _ = s.ListEnabledDevices(ctx, userID)
	for _, dv := range devs {
		if dv.Token == "store-test" {
			t.Fatal("disabled token still listed")
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM notification_preference WHERE workspace_id = $1 AND user_id = $2`, wsID, userID); err != nil {
		t.Fatal(err)
	}
	muted, err := s.SystemNotificationsMuted(ctx, wsID, userID)
	if err != nil || muted {
		t.Fatalf("no prefs row: muted=%v err=%v", muted, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO notification_preference (workspace_id, user_id, preferences) VALUES ($1,$2,'{"system_notifications":"muted"}')`, wsID, userID); err != nil {
		t.Fatal(err)
	}
	if muted, _ := s.SystemNotificationsMuted(ctx, wsID, userID); !muted {
		t.Fatal("want muted")
	}
	if _, err := s.UnreadInboxCount(ctx, userID); err != nil {
		t.Fatalf("unread count: %v", err)
	}
	if slug, err := s.WorkspaceSlug(ctx, wsID); err != nil || slug == "" {
		t.Fatalf("slug=%q err=%v", slug, err)
	}
}
