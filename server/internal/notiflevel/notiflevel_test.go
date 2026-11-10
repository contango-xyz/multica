package notiflevel

import (
	"testing"
	"time"
)

func TestEveryInboxTypeHasACategory(t *testing.T) {
	// packages/core/types/inbox.ts InboxItemType, minus "signal" (by group)
	for _, typ := range []string{"issue_assigned", "issue_subscribed", "unassigned", "assignee_changed", "status_changed",
		"priority_changed", "start_date_changed", "due_date_changed", "new_comment", "mentioned", "review_requested",
		"task_completed", "task_failed", "agent_blocked", "agent_completed", "reaction_added", "quick_create_done",
		"quick_create_failed", "quick_create_unconfirmed", "autopilot_paused", "autopilot_quota_exceeded", "children_done"} {
		if c := CategoryOf(typ, "", nil); c == "other" {
			t.Errorf("%s has no category", typ)
		}
	}
	for _, g := range []string{"merge", "decision", "access", "stalled", "blocking", "alert", "fyi"} {
		if c := CategoryOf("signal", g, nil); c == "fyi" && g != "fyi" {
			t.Errorf("signal group %s has no category", g)
		}
	}
}

func TestDefaultsFollowTheOwnersExamples(t *testing.T) {
	cases := map[string]Level{
		CategoryOf("signal", "merge", nil):                  Low,      // "a merge request is a low"
		CategoryOf("mentioned", "", []string{"t:bug"}):      Normal,   // a plain mention
		CategoryOf("signal", "decision", nil):               High,     // an ask for you
		CategoryOf("mentioned", "", []string{"production"}): Critical, // "a tag on a prod issue is a critical"
		CategoryOf("new_comment", "", []string{"security"}): Critical,
		CategoryOf("signal", "alert", nil):                  Critical,
		CategoryOf("something_new", "", nil):                Normal,
	}
	for cat, want := range cases {
		if got := Effective(nil, cat); got != want {
			t.Errorf("%s: %v, want %v", cat, got, want)
		}
	}
}

func TestOverridesAndMinimums(t *testing.T) {
	noon := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC) // a Tuesday
	prefs := map[string]string{MinMobileKey: "high", MinDesktopKey: "low", LevelKey("mentions"): "high"}
	if !Allowed(prefs, "mentions", Mobile, "", "", noon) {
		t.Error("a mention raised to high should reach a phone set to high")
	}
	if Allowed(prefs, "comments", Mobile, "", "", noon) {
		t.Error("a low comment must not reach a phone set to high")
	}
	if !Allowed(prefs, "comments", Desktop, "", "", noon) {
		t.Error("desktop at low takes everything")
	}
	if Allowed(map[string]string{MinMobileKey: "off"}, "production_security", Mobile, "", "", noon) {
		t.Error("off means off, even for critical")
	}
	if !Allowed(nil, "comments", Mobile, "", "", noon) {
		t.Error("no settings: nothing changes, everything pushes")
	}
}

func TestQuietHoursLetOnlyCriticalThrough(t *testing.T) {
	prefs := map[string]string{WorkHoursKey: "Europe/London|Mon-Fri|09:00-18:00"}
	night := time.Date(2026, 11, 10, 22, 0, 0, 0, time.UTC)
	saturday := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	day := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	for _, at := range []time.Time{night, saturday} {
		if Allowed(prefs, "asks", Mobile, "", "", at) {
			t.Errorf("%v: a high ask must wait outside working hours", at)
		}
		if !Allowed(prefs, "alerts", Mobile, "", "", at) {
			t.Errorf("%v: critical always pushes", at)
		}
	}
	if !Allowed(prefs, "asks", Mobile, "", "", day) {
		t.Error("inside working hours the ask pushes")
	}
	Away = func(_, _ string, _ time.Time) bool { return true }
	defer func() { Away = nil }()
	if Allowed(prefs, "asks", Mobile, "", "", day) || !Allowed(prefs, "alerts", Mobile, "", "", day) {
		t.Error("on a day off only critical pushes")
	}
}

func TestWorkHoursAcrossMidnight(t *testing.T) {
	v := "UTC|Mon|22:00-06:00"
	if !InWorkHours(v, time.Date(2026, 11, 9, 23, 0, 0, 0, time.UTC)) || // Monday 23:00
		!InWorkHours(v, time.Date(2026, 11, 10, 5, 0, 0, 0, time.UTC)) || // Tuesday 05:00, Monday's window
		InWorkHours(v, time.Date(2026, 11, 10, 23, 0, 0, 0, time.UTC)) { // Tuesday 23:00
		t.Error("a window crossing midnight belongs to the day it starts")
	}
}

func TestValidKey(t *testing.T) {
	for k, v := range map[string]string{MinMobileKey: "off", MinDesktopKey: "high", LevelKey("asks"): "critical"} {
		if known, ok := ValidKey(k, v); !known || !ok {
			t.Errorf("%s=%s should be valid", k, v)
		}
	}
	for k, v := range map[string]string{LevelKey("asks"): "off", LevelKey("nope"): "low", MinMobileKey: "loud"} {
		if known, ok := ValidKey(k, v); !known || ok {
			t.Errorf("%s=%s should be rejected", k, v)
		}
	}
	if known, _ := ValidKey("mentions", "muted"); known {
		t.Error("the old group keys are not this package's")
	}
}
