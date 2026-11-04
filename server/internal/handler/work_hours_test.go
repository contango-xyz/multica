package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValidateWorkHours(t *testing.T) {
	for _, ok := range []string{"Europe/London|Mon-Fri|09:00-18:00", "UTC|Mon,Wed,Fri|22:00-06:00", "Asia/Tokyo|Sat-Sun|00:00-23:59", "Europe/Madrid|Fri-Mon|08:30-17:30"} {
		if err := validateWorkHours(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "Europe/London", "Mars/Base|Mon-Fri|09:00-18:00", "Local|Mon|09:00-10:00", "UTC||09:00-18:00",
		"UTC|Monday|09:00-18:00", "UTC|Mon-Fri|9:00-18:00", "UTC|Mon-Fri|09:00-25:00", "UTC|Mon-Fri|09:00-09:00", "UTC|Mon-Fri|09:00"} {
		if err := validateWorkHours(bad); err == nil {
			t.Errorf("%q: accepted", bad)
		}
	}
}

func TestPatchNotificationPreferencesWorkHours(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM notification_preference WHERE workspace_id = $1 AND user_id = $2`,
			testWorkspaceID, testUserID)
	})
	patch := func(v string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		testHandler.PatchNotificationPreferences(rec, notificationPreferenceRequest(t, http.MethodPatch, map[string]string{"work_hours": v}))
		return rec
	}
	if rec := patch("Europe/London|Mon-Fri|09:00-18:00"); rec.Code != http.StatusOK {
		t.Fatalf("valid: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := patch("Europe/London|Mon-Fri|9-6"); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid: status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec := patch("") // clears it
	var response struct {
		Preferences map[string]string `json:"preferences"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("clear: status=%d err=%v", rec.Code, err)
	}
	if response.Preferences["work_hours"] != "" {
		t.Fatalf("not cleared: %#v", response.Preferences)
	}
}
