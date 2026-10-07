package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

func unregisterPush(t *testing.T, userID, token string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	req := withURLParam(newRequestAs(userID, http.MethodDelete, "/api/push/devices/"+token, nil), "token", token)
	testHandler.UnregisterPushDevice(rec, req)
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
	cases := map[string]map[string]any{
		"platform":    {"platform": "android", "token": "t", "bundle_id": "b", "environment": "production"},
		"environment": {"platform": "ios", "token": "t", "bundle_id": "b", "environment": "staging"},
		"empty token": {"platform": "ios", "token": "  ", "bundle_id": "b", "environment": "production"},
		"long token":  {"platform": "ios", "token": strings.Repeat("a", 201), "bundle_id": "b", "environment": "production"},
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

	if code := unregisterPush(t, testUserID, "tok-theirs"); code != http.StatusNoContent {
		t.Fatalf("status = %d", code)
	}
	if owner, _ := pushOwner(t, "tok-theirs"); owner != other {
		t.Fatalf("other user's token was deleted")
	}
	if code := unregisterPush(t, testUserID, "tok-mine"); code != http.StatusNoContent {
		t.Fatalf("status = %d", code)
	}
	if owner, _ := pushOwner(t, "tok-mine"); owner != "" {
		t.Fatalf("own token still present")
	}
}
