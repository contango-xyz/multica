package handler

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
)

func testAskDraft(t *testing.T, body map[string]any) service.IssueAskInput {
	t.Helper()
	raw, _ := json.Marshal(body)
	var in service.IssueAskInput
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	return in
}

func withAskDraftForTest(ctx context.Context, in service.IssueAskInput) context.Context {
	return context.WithValue(ctx, askDraftKey{}, &askDraft{input: in})
}
