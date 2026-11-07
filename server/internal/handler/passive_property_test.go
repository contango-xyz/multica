package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestParsePassivePropertiesUnit(t *testing.T) {
	got := ParsePassiveProperties(" Waiting on , ,OWNER NOTE,")
	if len(got) != 2 || !got["waiting on"] || !got["owner note"] {
		t.Fatalf("unexpected set: %v", got)
	}
	if got := ParsePassiveProperties(""); len(got) != 0 {
		t.Fatalf("empty env: expected empty set, got %v", got)
	}
}

// withPassiveProperties swaps the handler's passive set for one test.
func withPassiveProperties(t *testing.T, raw string) {
	t.Helper()
	prev := testHandler.PassiveProperties
	testHandler.PassiveProperties = ParsePassiveProperties(raw)
	t.Cleanup(func() { testHandler.PassiveProperties = prev })
}

type issueTimestamps struct {
	updatedAt, lastActivityAt time.Time
	revision                  int64
}

// seedIssueTimestamps pins both activity columns in the past so any bump is
// visible without sleeping.
func seedIssueTimestamps(t *testing.T, issueID string) issueTimestamps {
	t.Helper()
	base := time.Date(2020, time.January, 1, 0, 0, 0, 0, time.UTC)
	if _, err := testPool.Exec(context.Background(),
		`UPDATE issue SET updated_at = $2, last_activity_at = $2 WHERE id = $1`, issueID, base); err != nil {
		t.Fatalf("seed timestamps: %v", err)
	}
	return readIssueTimestamps(t, issueID)
}

func readIssueTimestamps(t *testing.T, issueID string) issueTimestamps {
	t.Helper()
	var ts issueTimestamps
	if err := testPool.QueryRow(context.Background(),
		`SELECT updated_at, last_activity_at, revision FROM issue WHERE id = $1`, issueID,
	).Scan(&ts.updatedAt, &ts.lastActivityAt, &ts.revision); err != nil {
		t.Fatalf("read timestamps: %v", err)
	}
	return ts
}

func unsetIssuePropertyRaw(t *testing.T, issueID, propertyID string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("DELETE", "/api/issues/"+issueID+"/properties/"+propertyID, nil)
	req = withIssuePropertyParams(req, issueID, propertyID)
	testHandler.DeleteIssueProperty(w, req)
	return w
}

func assertTimestampsUnchanged(t *testing.T, what string, before, after issueTimestamps) {
	t.Helper()
	if !after.updatedAt.Equal(before.updatedAt) || !after.lastActivityAt.Equal(before.lastActivityAt) {
		t.Fatalf("%s bumped activity: updated_at %s -> %s, last_activity_at %s -> %s",
			what, before.updatedAt, after.updatedAt, before.lastActivityAt, after.lastActivityAt)
	}
}

func assertTimestampsBumped(t *testing.T, what string, before, after issueTimestamps) {
	t.Helper()
	if !after.updatedAt.After(before.updatedAt) || !after.lastActivityAt.After(before.lastActivityAt) {
		t.Fatalf("%s did not bump activity: updated_at %s -> %s, last_activity_at %s -> %s",
			what, before.updatedAt, after.updatedAt, before.lastActivityAt, after.lastActivityAt)
	}
}

func TestPassivePropertyDoesNotBumpActivity(t *testing.T) {
	suffix := uuid.NewString()[:8]
	waitingName := "Waiting on " + suffix
	waiting := createTestProperty(t, map[string]any{"name": waitingName, "type": "text"})
	other := createTestProperty(t, map[string]any{"name": "Notes " + suffix, "type": "text"})
	// Configured in another case than the definition: matching ignores case.
	withPassiveProperties(t, "Something Else, WAITING ON "+suffix)
	issueID := createPropertyTestIssue(t, "passive property")

	published := make(chan map[string]any, 8)
	testHandler.Bus.Subscribe(protocol.EventIssuePropertiesChanged, func(e events.Event) {
		if p, ok := e.Payload.(map[string]any); ok && p["issue_id"] == issueID {
			select {
			case published <- p:
			default:
			}
		}
	})
	expectEvent := func(what string) map[string]any {
		t.Helper()
		select {
		case p := <-published:
			return p
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: no %s event published", what, protocol.EventIssuePropertiesChanged)
			return nil
		}
	}

	// Passive set: stored, revision bumped, event published, timestamps put.
	before := seedIssueTimestamps(t, issueID)
	if w := setIssuePropertyRaw(t, issueID, waiting.ID, "Dele: review"); w.Code != http.StatusOK {
		t.Fatalf("passive set: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	after := readIssueTimestamps(t, issueID)
	assertTimestampsUnchanged(t, "passive set", before, after)
	if after.revision != before.revision+1 {
		t.Fatalf("passive set: revision %d -> %d, want +1", before.revision, after.revision)
	}
	if p := expectEvent("passive set"); p["properties"].(map[string]any)[waiting.ID] != "Dele: review" {
		t.Fatalf("passive set event lacks the new value: %v", p)
	}

	// Passive change of an existing value.
	before = after
	if w := setIssuePropertyRaw(t, issueID, waiting.ID, "CI"); w.Code != http.StatusOK {
		t.Fatalf("passive change: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertTimestampsUnchanged(t, "passive change", before, readIssueTimestamps(t, issueID))
	expectEvent("passive change")

	// Passive unset.
	before = readIssueTimestamps(t, issueID)
	if w := unsetIssuePropertyRaw(t, issueID, waiting.ID); w.Code != http.StatusOK {
		t.Fatalf("passive unset: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	after = readIssueTimestamps(t, issueID)
	assertTimestampsUnchanged(t, "passive unset", before, after)
	if after.revision != before.revision+1 {
		t.Fatalf("passive unset: revision %d -> %d, want +1", before.revision, after.revision)
	}
	if p := expectEvent("passive unset"); p["properties"].(map[string]any)[waiting.ID] != nil {
		t.Fatalf("passive unset event still carries the value: %v", p)
	}

	// Non-passive set and unset still bump.
	before = seedIssueTimestamps(t, issueID)
	if w := setIssuePropertyRaw(t, issueID, other.ID, "note"); w.Code != http.StatusOK {
		t.Fatalf("non-passive set: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertTimestampsBumped(t, "non-passive set", before, readIssueTimestamps(t, issueID))
	before = seedIssueTimestamps(t, issueID)
	if w := unsetIssuePropertyRaw(t, issueID, other.ID); w.Code != http.StatusOK {
		t.Fatalf("non-passive unset: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertTimestampsBumped(t, "non-passive unset", before, readIssueTimestamps(t, issueID))

	// Mixed: every API path writes one property per call, so a mix is a
	// passive and a non-passive write in a row; the non-passive one bumps.
	before = seedIssueTimestamps(t, issueID)
	if w := setIssuePropertyRaw(t, issueID, waiting.ID, "Leo"); w.Code != http.StatusOK {
		t.Fatalf("mixed passive set: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if w := setIssuePropertyRaw(t, issueID, other.ID, "mixed"); w.Code != http.StatusOK {
		t.Fatalf("mixed non-passive set: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertTimestampsBumped(t, "mixed writes", before, readIssueTimestamps(t, issueID))

	// Activity is not reported for a passive change anywhere else either.
	var activityRows int
	if err := testPool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM activity_log WHERE issue_id = $1`, issueID).Scan(&activityRows); err != nil {
		t.Fatalf("count activity_log: %v", err)
	}
	if activityRows != 0 {
		t.Fatalf("property writes created %d activity_log rows", activityRows)
	}
}

func TestPassivePropertiesUnsetKeepsActivityBump(t *testing.T) {
	withPassiveProperties(t, "")
	waiting := createTestProperty(t, map[string]any{"name": "Waiting on " + uuid.NewString()[:8], "type": "text"})
	issueID := createPropertyTestIssue(t, "passive env unset")

	before := seedIssueTimestamps(t, issueID)
	if w := setIssuePropertyRaw(t, issueID, waiting.ID, "Dele"); w.Code != http.StatusOK {
		t.Fatalf("set: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertTimestampsBumped(t, "set with env unset", before, readIssueTimestamps(t, issueID))

	before = seedIssueTimestamps(t, issueID)
	if w := unsetIssuePropertyRaw(t, issueID, waiting.ID); w.Code != http.StatusOK {
		t.Fatalf("unset: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertTimestampsBumped(t, "unset with env unset", before, readIssueTimestamps(t, issueID))
}
