# iOS Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server pushes inbox items and finished chat replies to the user's iPhones directly through APNs, honouring the desktop notification preferences, and the iOS app registers for, presents and routes those pushes.

**Architecture:** A new `push_device` table + two user-scoped endpoints hold device tokens. A `server/internal/push` package (APNs HTTP/2 client with ES256 provider tokens, a bus-subscribed dispatcher with a bounded worker queue, and a DB-backed store) is wired in `main.go` only when APNs env config is present. The mobile app adds `expo-notifications` + `expo-application`, registers the raw APNs token after login, unregisters on logout, and maps notification payloads to routes with pure, tested functions.

**Tech Stack:** Go (chi, sqlc/pgx v5, `github.com/golang-jwt/jwt/v5` — already in go.mod, stdlib HTTP/2), Expo 55 / React Native 0.83, `expo-notifications`, `expo-application`, vitest, GitHub Actions + GHCR.

**Spec:** `docs/superpowers/specs/2026-10-07-push-notifications-design.md`

## Global Constraints

- Triggers: inbox items + chat replies only; no custom-property rule.
- Transport: direct APNs, token-based `.p8` auth; no Expo push relay.
- Preferences: muted event groups already never create inbox items; additionally no push when `system_notifications` is `muted` for the item's / chat session's workspace; read at send time.
- Body text truncated to 180 characters.
- Push is inert unless `MULTICA_APNS_KEY_ID`, `MULTICA_APNS_TEAM_ID` and a key (`MULTICA_APNS_KEY_PATH` or `MULTICA_APNS_KEY`) are all set; `MULTICA_APNS_ALLOWED_BUNDLE_IDS` (comma list, empty = allow all) restricts registration.
- Bus handlers must not block: hand work to a bounded queue; full queue → drop with a warning. Per-send timeout 10 s.
- Repo DB rules: no foreign keys; every index `CREATE [UNIQUE] INDEX CONCURRENTLY` in its own single-statement migration file. Outside handlers use `util.ParseUUID` and check errors.
- Mobile rules (`apps/mobile/AGENTS.md`): add native packages with `pnpm exec expo install`; mobile imports from core only types/pure utilities.
- iOS only. Public fork: never commit hostnames, Apple team IDs, bundle ids of ours, `.p8` keys or `.env*` files.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01YEaBDgLE4nKkyzLseJWm8A`.
- Branch: `contango/push-notifications`. Commands from repo root `/Users/ultrasecreth/Developer/multica` unless stated.
- No account-deletion feature exists on the server today (no `DeleteUser` query/handler), so the spec's "account deletion cleanup" has no hook point; out of scope until such a feature exists.

## Review Focus

1. An `inbox:new` event whose `item` is a Go struct (some publishers) instead of `map[string]any` → still pushes (payload decoded via JSON round-trip). Test: Task 5 `TestInboxNewAcceptsStructPayload`.
2. The same token re-registered by a different user (shared phone, re-login) → ownership moves; the old user stops receiving pushes on it. Test: Task 2 `TestRegisterPushDeviceMovesTokenToNewUser`.
3. Notification tapped while the app was killed (cold start) → still routes to the target. Covered by Task 8 using `getLastNotificationResponseAsync` + Task 7 pure routing tests; verified on device in Task 9.
4. A chat `chat:done` with no assistant message (cancelled/failed turn, empty content) → no push. Test: Task 5 `TestChatDoneWithoutContentIsIgnored`.
5. Logout on a phone → that phone gets no further pushes for the logged-out user even if the network call fails once (re-registration on next login moves/clears it). Test: Task 2 `TestUnregisterOnlyDeletesOwnToken`; Task 8 logout calls unregister before clearing auth.

---

### Task 1: Test DB + `push_device` schema and queries

**Files:**
- Create: `server/migrations/564_push_device.up.sql`, `564_push_device.down.sql`
- Create: `server/migrations/565_push_device_token_index.up.sql`, `.down.sql`
- Create: `server/migrations/566_push_device_user_index.up.sql`, `.down.sql`
- Create: `server/pkg/db/queries/push_device.sql`
- Generated: `server/pkg/db/generated/push_device.sql.go`, `models.go` (via `make sqlc`)

**Interfaces:**
- Produces (sqlc, package `db`): `UpsertPushDevice(ctx, UpsertPushDeviceParams{UserID pgtype.UUID; Platform, Token, BundleID, Environment string}) (PushDevice, error)`, `ListEnabledPushDevicesByUser(ctx, userID pgtype.UUID) ([]PushDevice, error)`, `DeletePushDeviceForUser(ctx, DeletePushDeviceForUserParams{UserID pgtype.UUID; Token string}) error`, `DisablePushDeviceByToken(ctx, token string) error`; model `PushDevice{ID, UserID pgtype.UUID; Platform, Token, BundleID, Environment string; CreatedAt, LastSeenAt, DisabledAt pgtype.Timestamptz}`.

- [ ] **Step 1: Local test database.** If `.env` is missing: `cp .env.example .env`. Run `make db-up`. If port 5432 is taken by another container, set a free `POSTGRES_PORT` and matching `DATABASE_URL` in `.env`. Then `cd server && set -a && source ../.env && set +a && go run ./cmd/migrate up`. Expected: migrations apply up to 563.

- [ ] **Step 2: Migrations.**

`564_push_device.up.sql`:
```sql
-- Device tokens for native push (APNs). No foreign keys by repo rule; rows
-- are owned by user_id and cleaned up in application code.
CREATE TABLE IF NOT EXISTS push_device (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios')),
    token TEXT NOT NULL,
    bundle_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at TIMESTAMPTZ
);
```
`564_push_device.down.sql`: `DROP TABLE IF EXISTS push_device;`
`565_push_device_token_index.up.sql`:
```sql
-- One row per APNs token; re-registration upserts on it.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_push_device_token
    ON push_device (token);
```
`565_push_device_token_index.down.sql`: `DROP INDEX CONCURRENTLY IF EXISTS idx_push_device_token;`
`566_push_device_user_index.up.sql`:
```sql
-- Serves the per-recipient device lookup on every push.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_push_device_user
    ON push_device (user_id);
```
`566_push_device_user_index.down.sql`: `DROP INDEX CONCURRENTLY IF EXISTS idx_push_device_user;`

- [ ] **Step 3: Queries** `server/pkg/db/queries/push_device.sql`:
```sql
-- name: UpsertPushDevice :one
INSERT INTO push_device (user_id, platform, token, bundle_id, environment)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (token) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    platform = EXCLUDED.platform,
    bundle_id = EXCLUDED.bundle_id,
    environment = EXCLUDED.environment,
    last_seen_at = now(),
    disabled_at = NULL
RETURNING *;

-- name: ListEnabledPushDevicesByUser :many
SELECT * FROM push_device
WHERE user_id = $1 AND disabled_at IS NULL
ORDER BY created_at;

-- name: DeletePushDeviceForUser :exec
DELETE FROM push_device WHERE user_id = $1 AND token = $2;

-- name: DisablePushDeviceByToken :exec
UPDATE push_device SET disabled_at = now()
WHERE token = $1 AND disabled_at IS NULL;
```

- [ ] **Step 4: Generate + migrate round trip.** `make sqlc`; then in `server/` (env sourced): `go run ./cmd/migrate up && go run ./cmd/migrate down && go run ./cmd/migrate up` (if `down` steps more than one migration, step down three times — check `go run ./cmd/migrate --help`). Expected: no errors; `go build ./...` passes.

- [ ] **Step 5: Commit**
```bash
git add server/migrations/564_* server/migrations/565_* server/migrations/566_* server/pkg/db/queries/push_device.sql server/pkg/db/generated
git commit -m "feat(server): push_device table and queries"
```

---

### Task 2: Device registration endpoints

**Files:**
- Create: `server/internal/push/config.go` (only `BundleAllowed` in this task)
- Create: `server/internal/handler/push_device.go`
- Create: `server/internal/handler/push_device_test.go`
- Modify: `server/cmd/server/router.go` (user-scoped group, next to `r.Get("/api/me", h.GetMe)` ~line 1652)

**Interfaces:**
- Consumes: Task 1 queries.
- Produces: `POST /api/push/devices` body `{"platform":"ios","token":string,"bundle_id":string,"environment":"sandbox"|"production"}` → 204; `DELETE /api/push/devices/{token}` → 204. `push.BundleAllowed(bundleID string) bool`.

- [ ] **Step 1: Failing tests** `server/internal/handler/push_device_test.go`:
```go
package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func resetPushDevices(t *testing.T) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `DELETE FROM push_device`); err != nil {
		t.Fatalf("reset push_device: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), `DELETE FROM push_device`) })
}

func registerPush(t *testing.T, userID string, body map[string]any) int {
	t.Helper()
	rec := httptest.NewRecorder()
	testHandler.RegisterPushDevice(rec, newRequestAs(userID, http.MethodPost, "/api/push/devices", body))
	return rec.Code
}

func pushOwner(t *testing.T, token string) (owner string, disabled bool) {
	t.Helper()
	err := testPool.QueryRow(context.Background(),
		`SELECT user_id::text, disabled_at IS NOT NULL FROM push_device WHERE token = $1`, token,
	).Scan(&owner, &disabled)
	if err != nil {
		return "", false
	}
	return owner, disabled
}

func validPushBody(token string) map[string]any {
	return map[string]any{"platform": "ios", "token": token, "bundle_id": "com.example.app", "environment": "production"}
}

func TestRegisterPushDeviceStoresToken(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetPushDevices(t)
	if code := registerPush(t, testUserID, validPushBody("tok-a")); code != http.StatusNoContent {
		t.Fatalf("status = %d", code)
	}
	if owner, _ := pushOwner(t, "tok-a"); owner != testUserID {
		t.Fatalf("owner = %q", owner)
	}
}

func TestRegisterPushDeviceMovesTokenToNewUser(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetPushDevices(t)
	other := createTestUserAndMember(t, "member")
	registerPush(t, testUserID, validPushBody("tok-shared"))
	if _, err := testPool.Exec(context.Background(), `UPDATE push_device SET disabled_at = now() WHERE token = 'tok-shared'`); err != nil {
		t.Fatal(err)
	}
	if code := registerPush(t, other, validPushBody("tok-shared")); code != http.StatusNoContent {
		t.Fatalf("status = %d", code)
	}
	owner, disabled := pushOwner(t, "tok-shared")
	if owner != other || disabled {
		t.Fatalf("owner=%q disabled=%v, want %q enabled", owner, disabled, other)
	}
}

func TestRegisterPushDeviceValidates(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetPushDevices(t)
	long := make([]byte, 201)
	for i := range long {
		long[i] = 'a'
	}
	cases := map[string]map[string]any{
		"platform":    {"platform": "android", "token": "t", "bundle_id": "b", "environment": "production"},
		"environment": {"platform": "ios", "token": "t", "bundle_id": "b", "environment": "staging"},
		"empty token": {"platform": "ios", "token": "  ", "bundle_id": "b", "environment": "production"},
		"long token":  {"platform": "ios", "token": string(long), "bundle_id": "b", "environment": "production"},
		"bundle":      {"platform": "ios", "token": "t", "bundle_id": "", "environment": "production"},
	}
	for name, body := range cases {
		if code := registerPush(t, testUserID, body); code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, code)
		}
	}
}

func TestRegisterPushDeviceRejectsUnlistedBundle(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetPushDevices(t)
	t.Setenv("MULTICA_APNS_ALLOWED_BUNDLE_IDS", "com.example.other")
	if code := registerPush(t, testUserID, validPushBody("tok-b")); code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", code)
	}
}

func TestUnregisterOnlyDeletesOwnToken(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetPushDevices(t)
	other := createTestUserAndMember(t, "member")
	registerPush(t, testUserID, validPushBody("tok-mine"))
	registerPush(t, other, validPushBody("tok-theirs"))

	del := func(userID, token string) int {
		rec := httptest.NewRecorder()
		req := newRequestAs(userID, http.MethodDelete, "/api/push/devices/"+token, nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("token", token)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		testHandler.UnregisterPushDevice(rec, req)
		return rec.Code
	}
	if code := del(testUserID, "tok-theirs"); code != http.StatusNoContent {
		t.Fatalf("status = %d", code)
	}
	if owner, _ := pushOwner(t, "tok-theirs"); owner != other {
		t.Fatalf("other user's token was deleted")
	}
	if code := del(testUserID, "tok-mine"); code != http.StatusNoContent {
		t.Fatalf("status = %d", code)
	}
	if owner, _ := pushOwner(t, "tok-mine"); owner != "" {
		t.Fatalf("own token still present")
	}
}
```
If `createTestUserAndMember` needs a different signature, use it as defined in `share_link_test.go:111`. If `newRequestAs` sets the user via a different mechanism than `X-User-ID`, use the helper existing tests use for "request as another user".

- [ ] **Step 2: Run, expect FAIL** — `cd server && set -a && source ../.env && set +a && go test ./internal/handler -run 'PushDevice|UnregisterOnly' -count=1`. Expected: compile error, `testHandler.RegisterPushDevice undefined`. (Tests must not report "database not available" skips — if they do, fix Step 1 of Task 1.)

- [ ] **Step 3: Implement.**

`server/internal/push/config.go`:
```go
// Package push delivers native push notifications (APNs) for inbox items and
// chat replies. It is inert unless APNs credentials are configured.
package push

import (
	"os"
	"strings"
)

// BundleAllowed reports whether devices of this app bundle may register.
// MULTICA_APNS_ALLOWED_BUNDLE_IDS is a comma list; empty allows any bundle.
func BundleAllowed(bundleID string) bool {
	raw := strings.TrimSpace(os.Getenv("MULTICA_APNS_ALLOWED_BUNDLE_IDS"))
	if raw == "" {
		return true
	}
	for _, id := range strings.Split(raw, ",") {
		if strings.TrimSpace(id) == bundleID {
			return true
		}
	}
	return false
}
```

`server/internal/handler/push_device.go`:
```go
package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/push"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const maxPushTokenLength = 200

type registerPushDeviceRequest struct {
	Platform    string `json:"platform"`
	Token       string `json:"token"`
	BundleID    string `json:"bundle_id"`
	Environment string `json:"environment"`
}

// RegisterPushDevice stores (or re-assigns) the caller's APNs device token.
func (h *Handler) RegisterPushDevice(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req registerPushDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	req.BundleID = strings.TrimSpace(req.BundleID)
	switch {
	case req.Platform != "ios":
		writeError(w, http.StatusBadRequest, "platform must be ios")
		return
	case req.Environment != "sandbox" && req.Environment != "production":
		writeError(w, http.StatusBadRequest, "environment must be sandbox or production")
		return
	case req.Token == "" || len(req.Token) > maxPushTokenLength:
		writeError(w, http.StatusBadRequest, "invalid token")
		return
	case req.BundleID == "":
		writeError(w, http.StatusBadRequest, "bundle_id is required")
		return
	}
	if !push.BundleAllowed(req.BundleID) {
		writeError(w, http.StatusForbidden, "bundle id not allowed")
		return
	}
	if _, err := h.Queries.UpsertPushDevice(r.Context(), db.UpsertPushDeviceParams{
		UserID:      parseUUID(userID),
		Platform:    req.Platform,
		Token:       req.Token,
		BundleID:    req.BundleID,
		Environment: req.Environment,
	}); err != nil {
		slog.Warn("UpsertPushDevice failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to register device")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// UnregisterPushDevice removes the caller's own token; another user's token
// is a silent no-op so the endpoint reveals nothing about it.
func (h *Handler) UnregisterPushDevice(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" || len(token) > maxPushTokenLength {
		writeError(w, http.StatusBadRequest, "invalid token")
		return
	}
	if err := h.Queries.DeletePushDeviceForUser(r.Context(), db.DeletePushDeviceForUserParams{
		UserID: parseUUID(userID),
		Token:  token,
	}); err != nil {
		slog.Warn("DeletePushDeviceForUser failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unregister device")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```
(Match the `logger` import path to the one `notification_preference.go` uses.)

In `router.go`, inside the user-scoped group after `r.Get("/api/me", h.GetMe)`:
```go
		r.Post("/api/push/devices", h.RegisterPushDevice)
		r.Delete("/api/push/devices/{token}", h.UnregisterPushDevice)
```

- [ ] **Step 4: Verify** — same `go test` command → PASS (5 tests, none skipped); `go build ./... && go vet ./internal/handler ./internal/push`.

- [ ] **Step 5: Commit**
```bash
git add server/internal/push/config.go server/internal/handler/push_device.go server/internal/handler/push_device_test.go server/cmd/server/router.go
git commit -m "feat(server): push device registration endpoints"
```

---

### Task 3: APNs config from env

**Files:**
- Modify: `server/internal/push/config.go`
- Create: `server/internal/push/config_test.go`

**Interfaces:**
- Produces: `type Config struct { KeyPEM []byte; KeyID string; TeamID string }`; `ConfigFromEnv() (Config, bool, error)` — `(_, false, nil)` when nothing is set; error when partially set or the key file is unreadable.

- [ ] **Step 1: Failing tests** `server/internal/push/config_test.go`:
```go
package push

import (
	"os"
	"path/filepath"
	"testing"
)

func clearAPNsEnv(t *testing.T) {
	for _, k := range []string{"MULTICA_APNS_KEY", "MULTICA_APNS_KEY_PATH", "MULTICA_APNS_KEY_ID", "MULTICA_APNS_TEAM_ID"} {
		t.Setenv(k, "")
	}
}

func TestConfigFromEnvUnsetIsDisabled(t *testing.T) {
	clearAPNsEnv(t)
	_, ok, err := ConfigFromEnv()
	if ok || err != nil {
		t.Fatalf("ok=%v err=%v, want disabled without error", ok, err)
	}
}

func TestConfigFromEnvPartialIsError(t *testing.T) {
	clearAPNsEnv(t)
	t.Setenv("MULTICA_APNS_KEY_ID", "KEY123")
	if _, _, err := ConfigFromEnv(); err == nil {
		t.Fatal("want error for partial config")
	}
}

func TestConfigFromEnvReadsKeyFile(t *testing.T) {
	clearAPNsEnv(t)
	path := filepath.Join(t.TempDir(), "AuthKey.p8")
	if err := os.WriteFile(path, []byte("PEM"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_APNS_KEY_PATH", path)
	t.Setenv("MULTICA_APNS_KEY_ID", "KEY123")
	t.Setenv("MULTICA_APNS_TEAM_ID", "TEAM123")
	cfg, ok, err := ConfigFromEnv()
	if err != nil || !ok || string(cfg.KeyPEM) != "PEM" || cfg.KeyID != "KEY123" || cfg.TeamID != "TEAM123" {
		t.Fatalf("cfg=%+v ok=%v err=%v", cfg, ok, err)
	}
}

func TestBundleAllowed(t *testing.T) {
	t.Setenv("MULTICA_APNS_ALLOWED_BUNDLE_IDS", "")
	if !BundleAllowed("x") {
		t.Fatal("empty list allows all")
	}
	t.Setenv("MULTICA_APNS_ALLOWED_BUNDLE_IDS", "a.b, c.d")
	if !BundleAllowed("c.d") || BundleAllowed("e.f") {
		t.Fatal("list membership")
	}
}
```

- [ ] **Step 2: Run** `cd server && go test ./internal/push -run 'Config|Bundle' -count=1` → FAIL (`ConfigFromEnv` undefined).

- [ ] **Step 3: Implement** — append to `config.go` (add `errors`, `fmt` imports):
```go
// Config holds APNs token-auth credentials.
type Config struct {
	KeyPEM []byte
	KeyID  string
	TeamID string
}

// ConfigFromEnv reads APNs credentials. Nothing set → (zero, false, nil):
// push stays off. Partially set or unreadable key → error.
func ConfigFromEnv() (Config, bool, error) {
	keyID := strings.TrimSpace(os.Getenv("MULTICA_APNS_KEY_ID"))
	teamID := strings.TrimSpace(os.Getenv("MULTICA_APNS_TEAM_ID"))
	keyInline := os.Getenv("MULTICA_APNS_KEY")
	keyPath := strings.TrimSpace(os.Getenv("MULTICA_APNS_KEY_PATH"))
	if keyID == "" && teamID == "" && strings.TrimSpace(keyInline) == "" && keyPath == "" {
		return Config{}, false, nil
	}
	var key []byte
	switch {
	case strings.TrimSpace(keyInline) != "":
		key = []byte(keyInline)
	case keyPath != "":
		b, err := os.ReadFile(keyPath)
		if err != nil {
			return Config{}, false, fmt.Errorf("read MULTICA_APNS_KEY_PATH: %w", err)
		}
		key = b
	}
	if len(key) == 0 || keyID == "" || teamID == "" {
		return Config{}, false, errors.New("APNs config incomplete: need key (MULTICA_APNS_KEY or MULTICA_APNS_KEY_PATH), MULTICA_APNS_KEY_ID and MULTICA_APNS_TEAM_ID")
	}
	return Config{KeyPEM: key, KeyID: keyID, TeamID: teamID}, true, nil
}
```

- [ ] **Step 4: Verify** — same command → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/internal/push/config.go server/internal/push/config_test.go
git commit -m "feat(server): APNs config from environment"
```

---

### Task 4: APNs client

**Files:**
- Create: `server/internal/push/apns.go`
- Create: `server/internal/push/apns_test.go`

**Interfaces:**
- Consumes: `Config` (Task 3).
- Produces:
  - `type Device struct { Token, BundleID, Environment string }`
  - `type Notification struct { Title, Body, ThreadID string; Badge *int; Data map[string]any }`
  - `var ErrTokenInvalid = errors.New("push: device token invalid")`
  - `type Sender interface { Send(ctx context.Context, d Device, n Notification) error }`
  - `NewAPNsClient(cfg Config) (*APNsClient, error)`; `(*APNsClient).Send` implements `Sender`.
  - Wire payload: `{"aps":{"alert":{"title","body"},"sound":"default","badge"?,"thread-id"?},"body":<Data>}` — custom data under `"body"`, the key `expo-notifications` exposes as `content.data` (Ruling: same convention Expo's own relay uses; mobile parser also accepts top-level data, Task 7).

- [ ] **Step 1: Failing tests** `server/internal/push/apns_test.go`:
```go
package push

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func testKey(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return key, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

type captured struct {
	path, auth, topic, pushType string
	body                        map[string]any
}

func fakeAPNs(t *testing.T, status int, reason string) (*httptest.Server, *captured) {
	t.Helper()
	got := &captured{}
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path = r.URL.Path
		got.auth = r.Header.Get("authorization")
		got.topic = r.Header.Get("apns-topic")
		got.pushType = r.Header.Get("apns-push-type")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got.body)
		w.WriteHeader(status)
		if reason != "" {
			_, _ = w.Write([]byte(`{"reason":"` + reason + `"}`))
		}
	}))
	ts.EnableHTTP2 = true
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return ts, got
}

func newTestClient(t *testing.T, ts *httptest.Server) (*APNsClient, *ecdsa.PrivateKey) {
	t.Helper()
	key, pemBytes := testKey(t)
	c, err := NewAPNsClient(Config{KeyPEM: pemBytes, KeyID: "KEY123", TeamID: "TEAM123"})
	if err != nil {
		t.Fatal(err)
	}
	c.httpClient = ts.Client()
	c.endpoints = map[string]string{"sandbox": ts.URL, "production": ts.URL}
	return c, key
}

func TestAPNsSendBuildsRequest(t *testing.T) {
	ts, got := fakeAPNs(t, http.StatusOK, "")
	c, key := newTestClient(t, ts)
	badge := 3
	err := c.Send(context.Background(),
		Device{Token: "abc123", BundleID: "com.example.app", Environment: "production"},
		Notification{Title: "T", Body: "B", ThreadID: "issue-1", Badge: &badge, Data: map[string]any{"kind": "inbox"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.path != "/3/device/abc123" || got.topic != "com.example.app" || got.pushType != "alert" {
		t.Fatalf("request = %+v", got)
	}
	tok := strings.TrimPrefix(got.auth, "bearer ")
	parsed, err := jwt.Parse(tok, func(*jwt.Token) (any, error) { return &key.PublicKey, nil })
	if err != nil || !parsed.Valid || parsed.Header["kid"] != "KEY123" {
		t.Fatalf("jwt invalid: %v %v", err, parsed.Header)
	}
	if iss, _ := parsed.Claims.(jwt.MapClaims)["iss"].(string); iss != "TEAM123" {
		t.Fatalf("iss = %q", iss)
	}
	aps := got.body["aps"].(map[string]any)
	alert := aps["alert"].(map[string]any)
	if alert["title"] != "T" || alert["body"] != "B" || aps["badge"].(float64) != 3 || aps["thread-id"] != "issue-1" {
		t.Fatalf("aps = %+v", aps)
	}
	if got.body["body"].(map[string]any)["kind"] != "inbox" {
		t.Fatalf("data = %+v", got.body["body"])
	}
}

func TestAPNsInvalidTokenResponses(t *testing.T) {
	for _, tc := range []struct {
		status int
		reason string
	}{{http.StatusGone, "Unregistered"}, {http.StatusBadRequest, "BadDeviceToken"}, {http.StatusBadRequest, "DeviceTokenNotForTopic"}} {
		ts, _ := fakeAPNs(t, tc.status, tc.reason)
		c, _ := newTestClient(t, ts)
		err := c.Send(context.Background(), Device{Token: "x", BundleID: "b", Environment: "sandbox"}, Notification{Title: "t"})
		if !errors.Is(err, ErrTokenInvalid) {
			t.Fatalf("%d %s: err = %v, want ErrTokenInvalid", tc.status, tc.reason, err)
		}
	}
}

func TestAPNsServerErrorIsNotTokenInvalid(t *testing.T) {
	ts, _ := fakeAPNs(t, http.StatusInternalServerError, "InternalServerError")
	c, _ := newTestClient(t, ts)
	err := c.Send(context.Background(), Device{Token: "x", BundleID: "b", Environment: "sandbox"}, Notification{Title: "t"})
	if err == nil || errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("err = %v", err)
	}
}

func TestAPNsUnknownEnvironment(t *testing.T) {
	ts, _ := fakeAPNs(t, http.StatusOK, "")
	c, _ := newTestClient(t, ts)
	c.endpoints = map[string]string{}
	if err := c.Send(context.Background(), Device{Token: "x", BundleID: "b", Environment: "sandbox"}, Notification{}); err == nil {
		t.Fatal("want error for unknown environment")
	}
}
```

- [ ] **Step 2: Run** `cd server && go test ./internal/push -run APNs -count=1` → FAIL (undefined `NewAPNsClient`).

- [ ] **Step 3: Implement** `server/internal/push/apns.go`:
```go
package push

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrTokenInvalid means APNs rejected the device token for good; the caller
// should stop sending to it.
var ErrTokenInvalid = errors.New("push: device token invalid")

// Device is one registered phone.
type Device struct {
	Token       string
	BundleID    string
	Environment string // "sandbox" | "production"
}

// Notification is what a user sees, plus routing data for the app.
type Notification struct {
	Title    string
	Body     string
	ThreadID string
	Badge    *int
	Data     map[string]any
}

// Sender delivers one notification to one device.
type Sender interface {
	Send(ctx context.Context, d Device, n Notification) error
}

// APNsClient talks to Apple Push Notification service with token auth.
type APNsClient struct {
	keyID      string
	teamID     string
	key        *ecdsa.PrivateKey
	httpClient *http.Client
	endpoints  map[string]string

	mu      sync.Mutex
	token   string
	tokenAt time.Time
}

const providerTokenTTL = 50 * time.Minute // Apple rejects tokens older than 60 min

func NewAPNsClient(cfg Config) (*APNsClient, error) {
	key, err := jwt.ParseECPrivateKeyFromPEM(cfg.KeyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse APNs key: %w", err)
	}
	return &APNsClient{
		keyID:  cfg.KeyID,
		teamID: cfg.TeamID,
		key:    key,
		// net/http negotiates HTTP/2 over TLS, which APNs requires.
		httpClient: &http.Client{Timeout: 10 * time.Second},
		endpoints: map[string]string{
			"production": "https://api.push.apple.com",
			"sandbox":    "https://api.sandbox.push.apple.com",
		},
	}, nil
}

func (c *APNsClient) providerToken() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Since(c.tokenAt) < providerTokenTTL {
		return c.token, nil
	}
	now := time.Now()
	t := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": c.teamID, "iat": now.Unix()})
	t.Header["kid"] = c.keyID
	signed, err := t.SignedString(c.key)
	if err != nil {
		return "", err
	}
	c.token, c.tokenAt = signed, now
	return signed, nil
}

func (c *APNsClient) Send(ctx context.Context, d Device, n Notification) error {
	base, ok := c.endpoints[d.Environment]
	if !ok {
		return fmt.Errorf("push: unknown APNs environment %q", d.Environment)
	}
	aps := map[string]any{
		"alert": map[string]any{"title": n.Title, "body": n.Body},
		"sound": "default",
	}
	if n.Badge != nil {
		aps["badge"] = *n.Badge
	}
	if n.ThreadID != "" {
		aps["thread-id"] = n.ThreadID
	}
	payload := map[string]any{"aps": aps}
	if len(n.Data) > 0 {
		payload["body"] = n.Data
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tok, err := c.providerToken()
	if err != nil {
		return fmt.Errorf("push: sign provider token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/3/device/"+d.Token, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "bearer "+tok)
	req.Header.Set("apns-topic", d.BundleID)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("content-type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("push: apns request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	var body struct {
		Reason string `json:"reason"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = json.Unmarshal(b, &body)
	switch {
	case resp.StatusCode == http.StatusGone,
		body.Reason == "BadDeviceToken",
		body.Reason == "Unregistered",
		body.Reason == "DeviceTokenNotForTopic":
		return fmt.Errorf("%w: %d %s", ErrTokenInvalid, resp.StatusCode, body.Reason)
	}
	return fmt.Errorf("push: apns status %d: %s", resp.StatusCode, body.Reason)
}
```

- [ ] **Step 4: Verify** — `go test ./internal/push -count=1` → PASS (config + APNs tests).

- [ ] **Step 5: Commit**
```bash
git add server/internal/push/apns.go server/internal/push/apns_test.go
git commit -m "feat(server): APNs client with token auth"
```

---

### Task 5: Dispatcher (events → pushes) with preferences and badge

**Files:**
- Create: `server/internal/push/dispatcher.go`
- Create: `server/internal/push/dispatcher_test.go`

**Interfaces:**
- Consumes: `Sender`, `Device`, `Notification`, `ErrTokenInvalid` (Task 4); `events.Bus`, `events.Event`, `protocol.EventInboxNew`, `protocol.EventChatDone`.
- Produces:
  - `type Store interface { ListEnabledDevices(ctx, userID string) ([]Device, error); DisableToken(ctx, token string) error; WorkspaceSlug(ctx, workspaceID string) (string, error); SystemNotificationsMuted(ctx, workspaceID, userID string) (bool, error); UnreadInboxCount(ctx, userID string) (int, error); ChatSessionTarget(ctx, sessionID string) (ownerID, agentName string, err error) }`
  - `NewDispatcher(store Store, sender Sender, queueSize int) *Dispatcher`; `(*Dispatcher).Register(bus *events.Bus)`; `(*Dispatcher).Start(workers int)`.

- [ ] **Step 1: Failing tests** `server/internal/push/dispatcher_test.go`:
```go
package push

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type fakeStore struct {
	devices  map[string][]Device
	muted    map[string]bool // workspaceID+"/"+userID
	unread   map[string]int
	disabled []string
	owner    string
	agent    string
}

func (s *fakeStore) ListEnabledDevices(_ context.Context, userID string) ([]Device, error) {
	return s.devices[userID], nil
}
func (s *fakeStore) DisableToken(_ context.Context, token string) error {
	s.disabled = append(s.disabled, token)
	return nil
}
func (s *fakeStore) WorkspaceSlug(_ context.Context, wsID string) (string, error) { return "slug-" + wsID, nil }
func (s *fakeStore) SystemNotificationsMuted(_ context.Context, wsID, userID string) (bool, error) {
	return s.muted[wsID+"/"+userID], nil
}
func (s *fakeStore) UnreadInboxCount(_ context.Context, userID string) (int, error) {
	return s.unread[userID], nil
}
func (s *fakeStore) ChatSessionTarget(context.Context, string) (string, string, error) {
	return s.owner, s.agent, nil
}

type sent struct {
	d Device
	n Notification
}

type fakeSender struct {
	mu   sync.Mutex
	got  []sent
	fail map[string]error
}

func (f *fakeSender) Send(_ context.Context, d Device, n Notification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, sent{d, n})
	return f.fail[d.Token]
}

func newTestDispatcher(store *fakeStore, sender *fakeSender) *Dispatcher {
	return NewDispatcher(store, sender, 8)
}

// drain processes queued jobs synchronously (no workers started).
func drain(d *Dispatcher) {
	for {
		select {
		case j := <-d.queue:
			d.process(context.Background(), j)
		default:
			return
		}
	}
}

func inboxEvent(item any) events.Event {
	return events.Event{Type: protocol.EventInboxNew, WorkspaceID: "ws1", Payload: map[string]any{"item": item}}
}

func memberItem() map[string]any {
	return map[string]any{
		"id": "item1", "workspace_id": "ws1", "recipient_type": "member", "recipient_id": "u1",
		"type": "mentioned", "title": "MUL-1 Fix login", "body": "Ana mentioned you",
		"issue_id": "issue1", "details": map[string]any{"comment_id": "c9"},
	}
}

func TestInboxNewPushesToAllRecipientDevices(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}, {Token: "b"}}}, unread: map[string]int{"u1": 4}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(memberItem()))
	drain(d)
	if len(sender.got) != 2 {
		t.Fatalf("sent %d, want 2", len(sender.got))
	}
	n := sender.got[0].n
	if n.Title != "MUL-1 Fix login" || n.Body != "Ana mentioned you" || n.Badge == nil || *n.Badge != 4 || n.ThreadID != "issue1" {
		t.Fatalf("notification = %+v", n)
	}
	want := map[string]any{"kind": "inbox", "workspace_slug": "slug-ws1", "item_id": "item1", "type": "mentioned", "issue_id": "issue1", "comment_id": "c9"}
	for k, v := range want {
		if n.Data[k] != v {
			t.Fatalf("data[%s] = %v, want %v (data %+v)", k, n.Data[k], v, n.Data)
		}
	}
}

func TestInboxNewAcceptsStructPayload(t *testing.T) {
	type itemStruct struct {
		ID            string  `json:"id"`
		WorkspaceID   string  `json:"workspace_id"`
		RecipientType string  `json:"recipient_type"`
		RecipientID   string  `json:"recipient_id"`
		Type          string  `json:"type"`
		Title         string  `json:"title"`
		Body          *string `json:"body"`
	}
	body := "b"
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(itemStruct{ID: "i", WorkspaceID: "ws1", RecipientType: "member", RecipientID: "u1", Type: "x", Title: "t", Body: &body}))
	drain(d)
	if len(sender.got) != 1 {
		t.Fatalf("sent %d", len(sender.got))
	}
}

func TestInboxNewIgnoresAgentRecipients(t *testing.T) {
	item := memberItem()
	item["recipient_type"] = "agent"
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(item))
	drain(d)
	if len(sender.got) != 0 {
		t.Fatalf("sent %d, want 0", len(sender.got))
	}
}

func TestSystemNotificationsMutedSuppressesOnlyThatWorkspace(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}, muted: map[string]bool{"ws1/u1": true}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(memberItem()))
	drain(d)
	if len(sender.got) != 0 {
		t.Fatalf("muted workspace pushed")
	}
	other := memberItem()
	other["workspace_id"] = "ws2"
	d.onInboxNew(events.Event{Type: protocol.EventInboxNew, WorkspaceID: "ws2", Payload: map[string]any{"item": other}})
	drain(d)
	if len(sender.got) != 1 {
		t.Fatalf("other workspace should push, sent %d", len(sender.got))
	}
}

func TestBodyIsTruncated(t *testing.T) {
	item := memberItem()
	long := make([]rune, 300)
	for i := range long {
		long[i] = 'é'
	}
	item["body"] = string(long)
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(item))
	drain(d)
	if got := len([]rune(sender.got[0].n.Body)); got != 180 {
		t.Fatalf("body runes = %d, want 180", got)
	}
}

func TestInvalidTokenIsDisabled(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "dead"}, {Token: "ok"}}}}
	sender := &fakeSender{fail: map[string]error{"dead": ErrTokenInvalid, "ok": nil}}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(memberItem()))
	drain(d)
	if len(store.disabled) != 1 || store.disabled[0] != "dead" {
		t.Fatalf("disabled = %v", store.disabled)
	}
}

func TestOtherSendErrorsKeepToken(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"u1": {{Token: "a"}}}}
	sender := &fakeSender{fail: map[string]error{"a": errors.New("timeout")}}
	d := newTestDispatcher(store, sender)
	d.onInboxNew(inboxEvent(memberItem()))
	drain(d)
	if len(store.disabled) != 0 {
		t.Fatalf("disabled = %v", store.disabled)
	}
}

func TestChatDonePushesToSessionOwner(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"owner": {{Token: "a"}}}, owner: "owner", agent: "Largo", unread: map[string]int{"owner": 1}}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onChatDone(events.Event{Type: protocol.EventChatDone, WorkspaceID: "ws1", ChatSessionID: "s1",
		Payload: protocol.ChatDonePayload{ChatSessionID: "s1", Content: "Done.\nDetails follow"}})
	drain(d)
	if len(sender.got) != 1 {
		t.Fatalf("sent %d", len(sender.got))
	}
	n := sender.got[0].n
	if n.Title != "Largo" || n.Body != "Done." || n.ThreadID != "s1" || n.Data["kind"] != "chat" || n.Data["session_id"] != "s1" || n.Data["workspace_slug"] != "slug-ws1" {
		t.Fatalf("notification = %+v", n)
	}
}

func TestChatDoneWithoutContentIsIgnored(t *testing.T) {
	store := &fakeStore{devices: map[string][]Device{"owner": {{Token: "a"}}}, owner: "owner", agent: "A"}
	sender := &fakeSender{}
	d := newTestDispatcher(store, sender)
	d.onChatDone(events.Event{Type: protocol.EventChatDone, WorkspaceID: "ws1", Payload: protocol.ChatDonePayload{ChatSessionID: "s1"}})
	drain(d)
	if len(sender.got) != 0 {
		t.Fatalf("sent %d, want 0", len(sender.got))
	}
}

func TestFullQueueDropsWithoutBlocking(t *testing.T) {
	store := &fakeStore{}
	d := NewDispatcher(store, &fakeSender{}, 1)
	d.onInboxNew(inboxEvent(memberItem()))
	d.onInboxNew(inboxEvent(memberItem())) // must return immediately, dropped
	if len(d.queue) != 1 {
		t.Fatalf("queue len = %d", len(d.queue))
	}
}

func TestRegisterSubscribesBothEvents(t *testing.T) {
	bus := events.New()
	NewDispatcher(&fakeStore{}, &fakeSender{}, 1).Register(bus)
	if bus.SubscriberCount(protocol.EventInboxNew) != 1 || bus.SubscriberCount(protocol.EventChatDone) != 1 {
		t.Fatal("dispatcher not subscribed")
	}
}
```

- [ ] **Step 2: Run** `cd server && go test ./internal/push -run 'Inbox|Chat|Muted|Truncated|Token|Queue|Register' -count=1` → FAIL (undefined `NewDispatcher`).

- [ ] **Step 3: Implement** `server/internal/push/dispatcher.go`:
```go
package push

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const maxBodyRunes = 180

// Store is the data the dispatcher needs; DBStore implements it.
type Store interface {
	ListEnabledDevices(ctx context.Context, userID string) ([]Device, error)
	DisableToken(ctx context.Context, token string) error
	WorkspaceSlug(ctx context.Context, workspaceID string) (string, error)
	SystemNotificationsMuted(ctx context.Context, workspaceID, userID string) (bool, error)
	UnreadInboxCount(ctx context.Context, userID string) (int, error)
	ChatSessionTarget(ctx context.Context, sessionID string) (ownerID, agentName string, err error)
}

type job struct {
	kind        string // "inbox" | "chat"
	userID      string // resolved recipient (chat: resolved in process)
	workspaceID string
	title       string
	body        string
	threadID    string
	sessionID   string
	data        map[string]any
}

// Dispatcher turns inbox:new / chat:done bus events into pushes. Bus
// handlers only enqueue; DB lookups and APNs calls run on workers.
type Dispatcher struct {
	store  Store
	sender Sender
	queue  chan job
}

func NewDispatcher(store Store, sender Sender, queueSize int) *Dispatcher {
	return &Dispatcher{store: store, sender: sender, queue: make(chan job, queueSize)}
}

func (d *Dispatcher) Register(bus *events.Bus) {
	bus.Subscribe(protocol.EventInboxNew, d.onInboxNew)
	bus.Subscribe(protocol.EventChatDone, d.onChatDone)
}

// Start runs workers for the process lifetime.
func (d *Dispatcher) Start(workers int) {
	for i := 0; i < workers; i++ {
		go func() {
			for j := range d.queue {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				d.process(ctx, j)
				cancel()
			}
		}()
	}
}

func (d *Dispatcher) enqueue(j job) {
	select {
	case d.queue <- j:
	default:
		slog.Warn("push queue full; dropping notification", "kind", j.kind)
	}
}

// decode re-marshals a payload fragment so map and struct publishers both work.
func decode(v any, out any) bool {
	raw, err := json.Marshal(v)
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, out) == nil
}

func truncate(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= maxBodyRunes {
		return string(r)
	}
	return string(r[:maxBodyRunes-1]) + "…"
}

func (d *Dispatcher) onInboxNew(e events.Event) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		return
	}
	var item struct {
		ID            string  `json:"id"`
		WorkspaceID   string  `json:"workspace_id"`
		RecipientType string  `json:"recipient_type"`
		RecipientID   string  `json:"recipient_id"`
		Type          string  `json:"type"`
		Title         string  `json:"title"`
		Body          *string `json:"body"`
		IssueID       *string `json:"issue_id"`
		Details       struct {
			CommentID string `json:"comment_id"`
		} `json:"details"`
	}
	if !decode(payload["item"], &item) || item.RecipientType != "member" || item.RecipientID == "" {
		return
	}
	wsID := item.WorkspaceID
	if wsID == "" {
		wsID = e.WorkspaceID
	}
	data := map[string]any{"kind": "inbox", "item_id": item.ID, "type": item.Type}
	thread := item.ID
	if item.IssueID != nil && *item.IssueID != "" {
		data["issue_id"] = *item.IssueID
		thread = *item.IssueID
	}
	if item.Details.CommentID != "" {
		data["comment_id"] = item.Details.CommentID
	}
	body := ""
	if item.Body != nil {
		body = *item.Body
	}
	d.enqueue(job{kind: "inbox", userID: item.RecipientID, workspaceID: wsID, title: item.Title,
		body: truncate(body), threadID: thread, data: data})
}

func (d *Dispatcher) onChatDone(e events.Event) {
	var p protocol.ChatDonePayload
	if !decode(e.Payload, &p) {
		return
	}
	first, _, _ := strings.Cut(strings.TrimSpace(p.Content), "\n")
	if first == "" || p.ChatSessionID == "" {
		return
	}
	d.enqueue(job{kind: "chat", workspaceID: e.WorkspaceID, body: truncate(first), threadID: p.ChatSessionID,
		sessionID: p.ChatSessionID, data: map[string]any{"kind": "chat", "session_id": p.ChatSessionID}})
}

func (d *Dispatcher) process(ctx context.Context, j job) {
	if j.kind == "chat" {
		owner, agent, err := d.store.ChatSessionTarget(ctx, j.sessionID)
		if err != nil || owner == "" {
			slog.Warn("push: chat session lookup failed", "session_id", j.sessionID, "error", err)
			return
		}
		j.userID, j.title = owner, agent
	}
	if muted, err := d.store.SystemNotificationsMuted(ctx, j.workspaceID, j.userID); err != nil || muted {
		return
	}
	devices, err := d.store.ListEnabledDevices(ctx, j.userID)
	if err != nil || len(devices) == 0 {
		return
	}
	slug, err := d.store.WorkspaceSlug(ctx, j.workspaceID)
	if err != nil {
		slog.Warn("push: workspace lookup failed", "workspace_id", j.workspaceID, "error", err)
		return
	}
	j.data["workspace_slug"] = slug
	n := Notification{Title: j.title, Body: j.body, ThreadID: j.threadID, Data: j.data}
	if count, err := d.store.UnreadInboxCount(ctx, j.userID); err == nil {
		n.Badge = &count
	}
	for _, dev := range devices {
		err := d.sender.Send(ctx, dev, n)
		switch {
		case err == nil:
		case errors.Is(err, ErrTokenInvalid):
			if derr := d.store.DisableToken(ctx, dev.Token); derr != nil {
				slog.Warn("push: disable token failed", "error", derr)
			}
		default:
			slog.Warn("push: send failed", "kind", j.kind, "error", err)
		}
	}
}
```

- [ ] **Step 4: Verify** — `go test ./internal/push -count=1 -race` → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/internal/push/dispatcher.go server/internal/push/dispatcher_test.go
git commit -m "feat(server): push dispatcher for inbox items and chat replies"
```

---

### Task 6: DB store, server wiring, image workflow

**Files:**
- Create: `server/internal/push/store_db.go`, `server/internal/push/store_db_test.go`
- Modify: `server/cmd/server/main.go` (after `registerNotificationListeners(bus, queries)` ~line 617)
- Create: `.github/workflows/contango-backend-image.yml`

**Interfaces:**
- Consumes: Task 1 queries; Tasks 3–5.
- Produces: `NewDBStore(q *db.Queries) *DBStore` implementing `Store`.

- [ ] **Step 1: Failing DB-backed test** `server/internal/push/store_db_test.go` — exercises `SystemNotificationsMuted` + device round trip against the test DB (skip without `DATABASE_URL`):
```go
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
	if err := pool.QueryRow(ctx, `SELECT m.user_id::text, m.workspace_id::text FROM member m LIMIT 1`).Scan(&userID, &wsID); err != nil {
		t.Skip("no member fixture in test DB")
	}
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
	muted, err := s.SystemNotificationsMuted(ctx, wsID, userID)
	if err != nil || muted {
		t.Fatalf("no prefs row: muted=%v err=%v", muted, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO notification_preference (workspace_id, user_id, preferences) VALUES ($1,$2,'{"system_notifications":"muted"}')
		ON CONFLICT (workspace_id, user_id) DO UPDATE SET preferences = EXCLUDED.preferences`, wsID, userID); err != nil {
		t.Fatal(err)
	}
	if muted, _ := s.SystemNotificationsMuted(ctx, wsID, userID); !muted {
		t.Fatal("want muted")
	}
}
```
Run: `cd server && set -a && source ../.env && set +a && go test ./internal/push -run DBStore -count=1` → FAIL (`NewDBStore` undefined). If the `notification_preference` unique constraint differs, adapt the `ON CONFLICT` target to it (see migration 064).

- [ ] **Step 2: Implement** `server/internal/push/store_db.go`:
```go
package push

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// DBStore reads push data through sqlc queries.
type DBStore struct{ q *db.Queries }

func NewDBStore(q *db.Queries) *DBStore { return &DBStore{q: q} }

func (s *DBStore) ListEnabledDevices(ctx context.Context, userID string) ([]Device, error) {
	uid, err := util.ParseUUID(userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListEnabledPushDevicesByUser(ctx, uid)
	if err != nil {
		return nil, err
	}
	out := make([]Device, 0, len(rows))
	for _, r := range rows {
		out = append(out, Device{Token: r.Token, BundleID: r.BundleID, Environment: r.Environment})
	}
	return out, nil
}

func (s *DBStore) DisableToken(ctx context.Context, token string) error {
	return s.q.DisablePushDeviceByToken(ctx, token)
}

func (s *DBStore) WorkspaceSlug(ctx context.Context, workspaceID string) (string, error) {
	id, err := util.ParseUUID(workspaceID)
	if err != nil {
		return "", err
	}
	ws, err := s.q.GetWorkspace(ctx, id)
	if err != nil {
		return "", err
	}
	return ws.Slug, nil
}

func (s *DBStore) SystemNotificationsMuted(ctx context.Context, workspaceID, userID string) (bool, error) {
	wid, err := util.ParseUUID(workspaceID)
	if err != nil {
		return false, err
	}
	uid, err := util.ParseUUID(userID)
	if err != nil {
		return false, err
	}
	pref, err := s.q.GetNotificationPreference(ctx, db.GetNotificationPreferenceParams{WorkspaceID: wid, UserID: uid})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var prefs map[string]string
	if json.Unmarshal(pref.Preferences, &prefs) != nil {
		return false, nil
	}
	return prefs["system_notifications"] == "muted", nil
}

func (s *DBStore) UnreadInboxCount(ctx context.Context, userID string) (int, error) {
	uid, err := util.ParseUUID(userID)
	if err != nil {
		return 0, err
	}
	rows, err := s.q.CountUnreadInboxByWorkspace(ctx, uid)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, r := range rows {
		total += int(r.Count)
	}
	return total, nil
}

func (s *DBStore) ChatSessionTarget(ctx context.Context, sessionID string) (string, string, error) {
	sid, err := util.ParseUUID(sessionID)
	if err != nil {
		return "", "", err
	}
	sess, err := s.q.GetChatSession(ctx, sid)
	if err != nil {
		return "", "", err
	}
	name := "Agent"
	if agent, err := s.q.GetAgent(ctx, sess.AgentID); err == nil && agent.Name != "" {
		name = agent.Name
	}
	return util.UUIDToString(sess.CreatorID), name, nil
}
```
Run the DBStore test → PASS. Also `go test ./internal/push -count=1 -race` → PASS.

- [ ] **Step 3: Wire in `main.go`** after `registerNotificationListeners(bus, queries)`:
```go
	// Native push (APNs): inert unless MULTICA_APNS_* is configured.
	if cfg, ok, err := push.ConfigFromEnv(); err != nil {
		slog.Error("push notifications disabled: invalid APNs config", "error", err)
	} else if !ok {
		slog.Info("push notifications not configured")
	} else if client, err := push.NewAPNsClient(cfg); err != nil {
		slog.Error("push notifications disabled: APNs client", "error", err)
	} else {
		dispatcher := push.NewDispatcher(push.NewDBStore(queries), client, 1000)
		dispatcher.Register(bus)
		dispatcher.Start(4)
		slog.Info("push notifications enabled")
	}
```
Add the import `"github.com/multica-ai/multica/server/internal/push"`. Run `go build ./... && go vet ./cmd/server ./internal/push`.

- [ ] **Step 4: Image workflow** `.github/workflows/contango-backend-image.yml`:
```yaml
name: contango-backend-image

# Fork-only: builds the backend image from contango/** branches so our
# server can run fork features (e.g. native push). Upstream workflows untouched.
on:
  push:
    branches: ["contango/**"]
    paths: ["server/**", "Dockerfile", ".github/workflows/contango-backend-image.yml"]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        run: echo "short=${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: Dockerfile
          platforms: linux/amd64
          push: true
          build-args: |
            VERSION=contango-${{ steps.meta.outputs.short }}
            COMMIT=${{ github.sha }}
          tags: |
            ghcr.io/${{ github.repository_owner }}/multica-backend:${{ steps.meta.outputs.short }}
            ghcr.io/${{ github.repository_owner }}/multica-backend:contango-latest
```

- [ ] **Step 5: Full server checks + commit** — `make test` (or, if it needs more setup, `cd server && go test ./... -count=1` with env sourced) → PASS; report any pre-existing failures by name.
```bash
git add server/internal/push/store_db.go server/internal/push/store_db_test.go server/cmd/server/main.go .github/workflows/contango-backend-image.yml
git commit -m "feat(server): wire APNs push dispatcher; fork backend image workflow"
```

---

### Task 7: Mobile — API calls and pure push routing

**Files:**
- Modify: `apps/mobile/data/api.ts` (after the issue-views methods)
- Modify: `apps/mobile/data/api.test.ts`
- Create: `apps/mobile/lib/push-routing.ts`, `apps/mobile/lib/push-routing.test.ts`

**Interfaces:**
- Produces:
  - `api.registerPushDevice(body: { platform: "ios"; token: string; bundle_id: string; environment: "sandbox" | "production" }): Promise<void>`; `api.unregisterPushDevice(token: string): Promise<void>`
  - `type PushData = { kind: "inbox"; workspace_slug: string; item_id: string; type?: string; issue_id?: string; comment_id?: string } | { kind: "chat"; workspace_slug: string; session_id: string }`
  - `parsePushData(raw: unknown): PushData | null` (accepts the object or `{ body: object }`)
  - `pushTarget(data: PushData): PushTarget` where `PushTarget = { pathname: "/[workspace]/issue/[id]"; params: { workspace: string; id: string; highlight?: string } } | { pathname: "/[workspace]/inbox/[id]"; params: { workspace: string; id: string } } | { pathname: "/[workspace]/inbox"; params: { workspace: string } } | { pathname: "/[workspace]/chat"; params: { workspace: string }; chatSessionId: string }`
  - `shouldPresentInForeground(data: PushData | null, ctx: { activeChatSessionId: string | null; onChatTab: boolean }): boolean`

- [ ] **Step 1: Failing tests.** Append to `apps/mobile/data/api.test.ts`:
```ts
describe("api push devices", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers a device", async () => {
    const body = { platform: "ios" as const, token: "abc", bundle_id: "com.example.app", environment: "production" as const };
    await api.registerPushDevice(body);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/push/devices");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("unregisters a device by token", async () => {
    await api.unregisterPushDevice("a/b");
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/push/devices/a%2Fb");
    expect(init.method).toBe("DELETE");
  });
});
```
Create `apps/mobile/lib/push-routing.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parsePushData, pushTarget, shouldPresentInForeground } from "./push-routing";

describe("parsePushData", () => {
  it("reads data nested under body (server/expo convention)", () => {
    expect(parsePushData({ body: { kind: "chat", workspace_slug: "w", session_id: "s" } }))
      .toEqual({ kind: "chat", workspace_slug: "w", session_id: "s" });
  });
  it("reads top-level data", () => {
    expect(parsePushData({ kind: "inbox", workspace_slug: "w", item_id: "i" })?.kind).toBe("inbox");
  });
  it("rejects unknown or incomplete payloads", () => {
    expect(parsePushData({ kind: "bogus", workspace_slug: "w" })).toBeNull();
    expect(parsePushData({ kind: "inbox", item_id: "i" })).toBeNull();
    expect(parsePushData(null)).toBeNull();
  });
});

describe("pushTarget", () => {
  it("issue items open the issue with the comment highlighted", () => {
    expect(pushTarget({ kind: "inbox", workspace_slug: "w", item_id: "i", issue_id: "is", comment_id: "c" }))
      .toEqual({ pathname: "/[workspace]/issue/[id]", params: { workspace: "w", id: "is", highlight: "c" } });
  });
  it("autopilot items open the inbox detail", () => {
    expect(pushTarget({ kind: "inbox", workspace_slug: "w", item_id: "i", type: "autopilot_paused" }))
      .toEqual({ pathname: "/[workspace]/inbox/[id]", params: { workspace: "w", id: "i" } });
  });
  it("other issue-less items open the inbox tab", () => {
    expect(pushTarget({ kind: "inbox", workspace_slug: "w", item_id: "i", type: "quick_create_done" }))
      .toEqual({ pathname: "/[workspace]/inbox", params: { workspace: "w" } });
  });
  it("chat opens the chat tab on that session", () => {
    expect(pushTarget({ kind: "chat", workspace_slug: "w", session_id: "s" }))
      .toEqual({ pathname: "/[workspace]/chat", params: { workspace: "w" }, chatSessionId: "s" });
  });
});

describe("shouldPresentInForeground", () => {
  const chat = { kind: "chat" as const, workspace_slug: "w", session_id: "s" };
  it("hides a chat push for the open chat", () =>
    expect(shouldPresentInForeground(chat, { activeChatSessionId: "s", onChatTab: true })).toBe(false));
  it("shows a chat push for another chat or when not on the chat tab", () => {
    expect(shouldPresentInForeground(chat, { activeChatSessionId: "x", onChatTab: true })).toBe(true);
    expect(shouldPresentInForeground(chat, { activeChatSessionId: "s", onChatTab: false })).toBe(true);
  });
  it("always shows inbox pushes and unknown payloads", () => {
    expect(shouldPresentInForeground({ kind: "inbox", workspace_slug: "w", item_id: "i" }, { activeChatSessionId: null, onChatTab: false })).toBe(true);
    expect(shouldPresentInForeground(null, { activeChatSessionId: null, onChatTab: true })).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @multica/mobile exec vitest run data/api.test.ts lib/push-routing.test.ts` → FAIL (`registerPushDevice` not a function; module `./push-routing` missing).

- [ ] **Step 3: Implement.** In `apps/mobile/data/api.ts`:
```ts
  // --- Native push (APNs device tokens) ---
  async registerPushDevice(body: {
    platform: "ios";
    token: string;
    bundle_id: string;
    environment: "sandbox" | "production";
  }): Promise<void> {
    await this.fetch<void>("/api/push/devices", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async unregisterPushDevice(token: string): Promise<void> {
    await this.fetch<void>(`/api/push/devices/${encodeURIComponent(token)}`, {
      method: "DELETE",
    });
  }
```
`apps/mobile/lib/push-routing.ts`:
```ts
/**
 * Push notification payload → screen. Mirrors getInboxNavigationTarget
 * (lib/inbox-display.ts) so a tap lands where tapping the inbox row would.
 * The server puts routing data under `body` (the key expo-notifications
 * exposes as content.data); top-level data is accepted too.
 */
export type PushData =
  | { kind: "inbox"; workspace_slug: string; item_id: string; type?: string; issue_id?: string; comment_id?: string }
  | { kind: "chat"; workspace_slug: string; session_id: string };

export type PushTarget =
  | { pathname: "/[workspace]/issue/[id]"; params: { workspace: string; id: string; highlight?: string } }
  | { pathname: "/[workspace]/inbox/[id]"; params: { workspace: string; id: string } }
  | { pathname: "/[workspace]/inbox"; params: { workspace: string } }
  | { pathname: "/[workspace]/chat"; params: { workspace: string }; chatSessionId: string };

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

export function parsePushData(raw: unknown): PushData | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const src = obj.body && typeof obj.body === "object" ? (obj.body as Record<string, unknown>) : obj;
  const workspace_slug = str(src.workspace_slug);
  if (!workspace_slug) return null;
  if (src.kind === "inbox") {
    const item_id = str(src.item_id);
    if (!item_id) return null;
    return {
      kind: "inbox",
      workspace_slug,
      item_id,
      ...(str(src.type) ? { type: str(src.type) } : {}),
      ...(str(src.issue_id) ? { issue_id: str(src.issue_id) } : {}),
      ...(str(src.comment_id) ? { comment_id: str(src.comment_id) } : {}),
    };
  }
  if (src.kind === "chat") {
    const session_id = str(src.session_id);
    return session_id ? { kind: "chat", workspace_slug, session_id } : null;
  }
  return null;
}

export function pushTarget(data: PushData): PushTarget {
  const workspace = data.workspace_slug;
  if (data.kind === "chat") {
    return { pathname: "/[workspace]/chat", params: { workspace }, chatSessionId: data.session_id };
  }
  if (data.issue_id) {
    return {
      pathname: "/[workspace]/issue/[id]",
      params: { workspace, id: data.issue_id, ...(data.comment_id ? { highlight: data.comment_id } : {}) },
    };
  }
  if (data.type === "autopilot_quota_exceeded" || data.type === "autopilot_paused") {
    return { pathname: "/[workspace]/inbox/[id]", params: { workspace, id: data.item_id } };
  }
  return { pathname: "/[workspace]/inbox", params: { workspace } };
}

export function shouldPresentInForeground(
  data: PushData | null,
  ctx: { activeChatSessionId: string | null; onChatTab: boolean },
): boolean {
  if (data?.kind !== "chat") return true;
  return !(ctx.onChatTab && ctx.activeChatSessionId === data.session_id);
}
```

- [ ] **Step 4: Verify** — same vitest command → PASS; `pnpm --filter @multica/mobile typecheck` → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/mobile/data/api.ts apps/mobile/data/api.test.ts apps/mobile/lib/push-routing.ts apps/mobile/lib/push-routing.test.ts
git commit -m "feat(mobile): push device API and notification routing"
```

---

### Task 8: Mobile — registration, presentation, taps, badge

**Files:**
- Modify: `apps/mobile/package.json` (via expo install), `apps/mobile/app.config.ts` (plugins)
- Create: `apps/mobile/data/push-registration.ts`
- Create: `apps/mobile/lib/use-push-notifications.ts`
- Modify: `apps/mobile/app/(app)/[workspace]/_layout.tsx` (mount the hook next to `useMyIssuesRealtime()` ~line 79)
- Modify: `apps/mobile/data/auth-store.ts` (`logout`, ~line 81)

**Interfaces:**
- Consumes: Task 7 (`api.registerPushDevice`, `api.unregisterPushDevice`, `parsePushData`, `pushTarget`, `shouldPresentInForeground`); `useChatSessionPickerStore` (`activeSessionId`, `requestSelect`); `useInboxUnreadCount` (`lib/unread-counts.ts`).
- Produces: `registerForPush(): Promise<void>`, `unregisterForPush(): Promise<void>`, `usePushNotifications(): void`.

- [ ] **Step 1: Dependencies** — `cd apps/mobile && pnpm exec expo install expo-notifications expo-application`. In `app.config.ts` `plugins`, add `"expo-notifications",` after `"expo-secure-store",`.

- [ ] **Step 2: `apps/mobile/data/push-registration.ts`**:
```ts
/**
 * Registers this phone's raw APNs token with the server (direct APNs, no
 * Expo relay). Environment comes from the signed entitlement, not __DEV__:
 * a Release build signed for development still talks to the APNs sandbox.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Application from "expo-application";
import * as SecureStore from "expo-secure-store";
import { api } from "@/data/api";

const TOKEN_KEY = "multica_push_token";

export async function registerForPush(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const current = await Notifications.getPermissionsAsync();
    const status = current.granted ? current : await Notifications.requestPermissionsAsync();
    if (!status.granted) return;
    const env = await Application.getIosPushNotificationServiceEnvironmentAsync();
    const bundleId = Application.applicationId;
    if (!env || !bundleId) return; // simulator / unsigned build
    const { data: token } = await Notifications.getDevicePushTokenAsync();
    if (typeof token !== "string" || !token) return;
    await api.registerPushDevice({
      platform: "ios",
      token,
      bundle_id: bundleId,
      environment: env === "production" ? "production" : "sandbox",
    });
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } catch (err) {
    console.log("[push] registration failed", err);
  }
}

export async function unregisterForPush(): Promise<void> {
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!token) return;
    await api.unregisterPushDevice(token);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch (err) {
    console.log("[push] unregister failed", err);
  }
}
```

- [ ] **Step 3: `apps/mobile/lib/use-push-notifications.ts`**:
```ts
/**
 * Push lifecycle for a logged-in workspace session: register the device,
 * decide foreground presentation, route taps (also cold-start taps), keep
 * the app badge in sync with the unread inbox count.
 */
import { useEffect } from "react";
import { router, usePathname } from "expo-router";
import * as Notifications from "expo-notifications";
import { registerForPush } from "@/data/push-registration";
import { useChatSessionPickerStore } from "@/data/stores/chat-session-picker-store";
import { useInboxUnreadCount } from "@/lib/unread-counts";
import { parsePushData, pushTarget, shouldPresentInForeground } from "@/lib/push-routing";

let pathnameRef = "";

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = parsePushData(notification.request.content.data);
    const show = shouldPresentInForeground(data, {
      activeChatSessionId: useChatSessionPickerStore.getState().activeSessionId,
      onChatTab: pathnameRef.endsWith("/chat"),
    });
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: true };
  },
});

function openFromResponse(response: Notifications.NotificationResponse | null) {
  const data = parsePushData(response?.notification.request.content.data);
  if (!data) return;
  const target = pushTarget(data);
  if (target.pathname === "/[workspace]/chat") {
    useChatSessionPickerStore.getState().requestSelect(target.chatSessionId);
    router.navigate({ pathname: target.pathname, params: target.params });
    return;
  }
  router.navigate({ pathname: target.pathname, params: target.params });
}

export function usePushNotifications(): void {
  const pathname = usePathname();
  pathnameRef = pathname;
  const unread = useInboxUnreadCount();

  useEffect(() => {
    void registerForPush();
    void Notifications.getLastNotificationResponseAsync().then(openFromResponse);
    const sub = Notifications.addNotificationResponseReceivedListener(openFromResponse);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (typeof unread === "number") void Notifications.setBadgeCountAsync(unread);
  }, [unread]);
}
```
Check `useInboxUnreadCount`'s actual return shape in `lib/unread-counts.ts` and adapt the badge effect to the total unread number it exposes (sum across workspaces if it returns per-workspace counts). If `expo-router`'s typed routes reject the `pathname`/`params` object, cast through the existing pattern used by `getInboxNavigationTarget` callers.

- [ ] **Step 4: Mount + logout.** In `app/(app)/[workspace]/_layout.tsx` import and call `usePushNotifications();` next to `useMyIssuesRealtime();`. In `data/auth-store.ts` `logout`, call `await unregisterForPush();` (import from `@/data/push-registration`) as the first statement, before the token is cleared, so the DELETE is still authenticated.

- [ ] **Step 5: Verify + commit** — `pnpm --filter @multica/mobile typecheck && pnpm --filter @multica/mobile lint && pnpm --filter @multica/mobile test` → PASS.
```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/app.config.ts apps/mobile/data/push-registration.ts apps/mobile/lib/use-push-notifications.ts "apps/mobile/app/(app)/[workspace]/_layout.tsx" apps/mobile/data/auth-store.ts
git commit -m "feat(mobile): register for push, route taps, sync badge"
```

---

### Task 9: Rollout handoff + device verification

**Files:**
- Create: `docs/contango/push-rollout.md` (no hostnames, team ids, bundle ids or keys — placeholders only)

- [ ] **Step 1: Handoff document** `docs/contango/push-rollout.md` covering, with placeholders `<KEY_ID>`, `<TEAM_ID>`, `<BUNDLE_ID>`:
  1. Apple: Developer → Keys → "+" → enable Apple Push Notifications service → download `AuthKey_<KEY_ID>.p8` (one download only).
  2. GHCR: make `ghcr.io/contango-xyz/multica-backend` public, or `docker login ghcr.io` on the box with a read:packages token.
  3. Box: copy the `.p8` to a root-only path (e.g. `/etc/multica/apns/AuthKey.p8`, mode 600) and mount it read-only into the backend container; set `MULTICA_BACKEND_IMAGE=ghcr.io/contango-xyz/multica-backend`, `MULTICA_IMAGE_TAG=<short-sha>`, `MULTICA_APNS_KEY_PATH=<path in container>`, `MULTICA_APNS_KEY_ID=<KEY_ID>`, `MULTICA_APNS_TEAM_ID=<TEAM_ID>`, `MULTICA_APNS_ALLOWED_BUNDLE_IDS=<BUNDLE_ID>`.
  4. Take a DB backup, pull, restart backend; expect log `push notifications enabled`; `/health` OK; `push_device` table exists.
  5. Rollback: previous image tag; the extra table is harmless.

- [ ] **Step 2: Push branch** — `git push contango contango/push-notifications`; confirm the `contango-backend-image` workflow run succeeds and the image tag exists.

- [ ] **Step 3: Native project + device build.** In `apps/mobile`: run a non-clean prebuild with the production env (as in the saved-views work) so the `expo-notifications` plugin adds the `aps-environment` entitlement; `cd ios && pod install`. Confirm the local iOS 27 fixes survived (SceneDelegate in `AppDelegate.swift`, `UIApplicationSceneManifest`, deployment target 16.0, `ENABLE_USER_SCRIPT_SANDBOXING = NO`) and `Multica/Multica.entitlements` contains `aps-environment`. Build Release for the phone with `-allowProvisioningUpdates` (this enables the Push capability on the App ID) and install with `devicectl`.

- [ ] **Step 4: End-to-end (after the server rollout).** On the locked phone: accept the permission prompt on first launch; @mention the user from web → banner within seconds, badge = unread count, tap opens the issue with the comment highlighted; an agent chat reply → banner opens that chat; with that chat open, another reply → no banner; set "System notifications" off for the workspace on web → next @mention does not push; log out → no further pushes.

- [ ] **Step 5: Commit**
```bash
git add docs/contango/push-rollout.md
git commit -m "docs: push notification rollout handoff"
```
