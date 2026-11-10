package main

import (
	"context"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type fakeLevelStore struct {
	prefs  map[string]string
	labels []string
}

func (f fakeLevelStore) NotificationPrefs(context.Context, string, string) (map[string]string, error) {
	return f.prefs, nil
}
func (f fakeLevelStore) IssueLabels(context.Context, string, string) ([]string, error) {
	return f.labels, nil
}

func TestDesktopNotifyGate(t *testing.T) {
	item := map[string]any{"workspace_id": "ws", "type": "new_comment", "issue_id": "i1"}
	if !desktopNotifyGate(fakeLevelStore{})("ws", "u", item) {
		t.Error("no preferences: banners as before")
	}
	high := fakeLevelStore{prefs: map[string]string{"push_min_desktop": "high"}}
	if desktopNotifyGate(high)("ws", "u", item) {
		t.Error("a low comment must not pop up on a desktop set to high")
	}
	signal := map[string]any{"workspace_id": "ws", "type": "signal", "details": map[string]any{"group": "decision"}}
	if !desktopNotifyGate(high)("ws", "u", signal) {
		t.Error("an ask (high) pops up on a desktop set to high")
	}
	prod := fakeLevelStore{prefs: map[string]string{"push_min_desktop": "critical"}, labels: []string{"security"}}
	if !desktopNotifyGate(prod)("ws", "u", item) {
		t.Error("anything on a security card is critical")
	}
}

type fakeTimeOff struct{ rows []db.MemberTimeOff }

func (f fakeTimeOff) ListMemberTimeOff(context.Context, db.ListMemberTimeOffParams) ([]db.MemberTimeOff, error) {
	return f.rows, nil
}

func TestAwayFromTimeOff(t *testing.T) {
	const ws, me, other = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"
	mine, _ := util.ParseUUID(me)
	theirs, _ := util.ParseUUID(other)
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	if !awayFromTimeOff(fakeTimeOff{rows: []db.MemberTimeOff{{UserID: mine}}})(ws, me, now) {
		t.Error("my time off today makes me away")
	}
	if awayFromTimeOff(fakeTimeOff{rows: []db.MemberTimeOff{{UserID: theirs}}})(ws, me, now) {
		t.Error("someone else's time off doesn't")
	}
}
