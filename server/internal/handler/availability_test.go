package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func availabilityRequest(t *testing.T, method, path string, body any) *http.Request {
	t.Helper()
	member, err := testHandler.Queries.GetMemberByUserAndWorkspace(context.Background(),
		db.GetMemberByUserAndWorkspaceParams{UserID: parseUUID(testUserID), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil {
		t.Fatalf("load test member: %v", err)
	}
	req := newRequest(method, path, body)
	return req.WithContext(middleware.SetMemberContext(req.Context(), testWorkspaceID, member))
}

func resetAvailability(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	for _, q := range []string{`DELETE FROM member_time_off WHERE workspace_id = $1`,
		`DELETE FROM member_availability WHERE workspace_id = $1`} {
		if _, err := testPool.Exec(ctx, q, testWorkspaceID); err != nil {
			t.Fatalf("reset availability: %v", err)
		}
	}
}

func myAvailability(t *testing.T) memberAvailabilityResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	testHandler.GetAvailability(rec, availabilityRequest(t, http.MethodGet, "/api/availability?days=30", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("get availability: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Members []memberAvailabilityResponse `json:"members"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, m := range out.Members {
		if m.UserID == testUserID {
			return m
		}
	}
	t.Fatalf("test user missing from availability")
	return memberAvailabilityResponse{}
}

func TestAvailabilityManualTimeOffShowsAndDeletes(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetAvailability(t)
	t.Cleanup(func() { resetAvailability(t) })
	today := time.Now().UTC().Format("2006-01-02")
	rec := httptest.NewRecorder()
	testHandler.CreateMyTimeOff(rec, availabilityRequest(t, http.MethodPost, "/api/availability/me/time-off",
		map[string]any{"starts_on": today, "label": "holiday"}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var created timeOffResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	me := myAvailability(t)
	if !me.AwayToday || len(me.TimeOff) != 1 || me.TimeOff[0].Source != "manual" {
		t.Fatalf("want away today with one manual entry, got %+v", me)
	}
	del := availabilityRequest(t, http.MethodDelete, "/api/availability/me/time-off/"+created.ID, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", created.ID)
	del = del.WithContext(context.WithValue(del.Context(), chi.RouteCtxKey, rctx))
	rec = httptest.NewRecorder()
	testHandler.DeleteMyTimeOff(rec, del)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if me := myAvailability(t); me.AwayToday || len(me.TimeOff) != 0 {
		t.Fatalf("want no time off after delete, got %+v", me)
	}
}

func TestAvailabilityRejectsBadDates(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	rec := httptest.NewRecorder()
	testHandler.CreateMyTimeOff(rec, availabilityRequest(t, http.MethodPost, "/api/availability/me/time-off",
		map[string]any{"starts_on": "2026-11-10", "ends_on": "2026-11-09"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for an end before the start, got %d", rec.Code)
	}
}

func TestAvailabilityImportReplacesItsSource(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetAvailability(t)
	t.Cleanup(func() { resetAvailability(t) })
	day := time.Now().UTC().AddDate(0, 0, 3).Format("2006-01-02")
	run := func(entries []map[string]any) map[string]any {
		rec := httptest.NewRecorder()
		testHandler.ImportTimeOff(rec, availabilityRequest(t, http.MethodPut, "/api/availability/import",
			map[string]any{"source": "shared-ical", "user_ids": []string{testUserID}, "entries": entries}))
		if rec.Code != http.StatusOK {
			t.Fatalf("import: %d %s", rec.Code, rec.Body.String())
		}
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	run([]map[string]any{{"user_id": testUserID, "uid": "a", "starts_on": day, "label": "OOO"},
		{"user_id": testUserID, "uid": "b", "starts_on": day, "ends_on": day, "half_day": true}})
	run([]map[string]any{{"user_id": testUserID, "uid": "a", "starts_on": day, "label": "OOO again"}}) // same uid updates
	me := myAvailability(t)
	if len(me.TimeOff) != 1 || me.TimeOff[0].Label != "OOO again" || me.TimeOff[0].Source != "shared-ical" {
		t.Fatalf("want one updated imported entry, got %+v", me.TimeOff)
	}
	out := run(nil)
	if out["removed"].(float64) != 1 || len(myAvailability(t).TimeOff) != 0 {
		t.Fatalf("an empty feed should remove the source's entries, got %v", out)
	}
}

func TestAvailabilityBackupAndICalAddressStayPrivate(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetAvailability(t)
	t.Cleanup(func() { resetAvailability(t) })
	rec := httptest.NewRecorder()
	testHandler.UpdateMyAvailability(rec, availabilityRequest(t, http.MethodPut, "/api/availability/me",
		map[string]any{"personal_ical_url": "https://calendar.example.com/private-abc/basic.ics"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("set: %d %s", rec.Code, rec.Body.String())
	}
	if json.Valid(rec.Body.Bytes()) && strings.Contains(rec.Body.String(), "private-abc") {
		t.Fatalf("the address must never be echoed back: %s", rec.Body.String())
	}
	me := myAvailability(t)
	if !me.PersonalICal {
		t.Fatalf("want personal_ical true, got %+v", me)
	}
	rec = httptest.NewRecorder()
	testHandler.UpdateMyAvailability(rec, availabilityRequest(t, http.MethodPut, "/api/availability/me",
		map[string]any{"backup_user_id": testUserID}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("you can't be your own backup: got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	testHandler.ListICalSources(rec, availabilityRequest(t, http.MethodGet, "/api/availability/ical-sources", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "private-abc") {
		t.Fatalf("admins get the addresses for the import job: %d %s", rec.Code, rec.Body.String())
	}
}
