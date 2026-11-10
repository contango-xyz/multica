package handler

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// Reads of one person's rows on one issue, sent together, all succeed: each
// read updates every unread row on the issue, and in parallel they deadlocked
// until reads took the recipient's advisory lock (2026-11-10).
func TestParallelMarkInboxReadOnOneIssueAllSucceed(t *testing.T) {
	f := newIssueInboxFixture(t, "parallel inbox reads")
	var ids []string
	for i := 0; i < 8; i++ {
		ids = append(ids, f.notify("new_comment", "info", i+1))
	}
	handler := inboxWorkspaceHandler(testHandler.MarkInboxRead)
	codes := make([]int, 0, len(ids)*3)
	var mu sync.Mutex
	var wg sync.WaitGroup
	// Waves of maxInboxReadsPerUser, the most one person has in flight (the
	// client reads a section in batches of that size).
	for round := 0; round < 3; round++ {
		for i, id := range ids {
			if i%maxInboxReadsPerUser == 0 {
				wg.Wait()
				dbfx.Exec(t, `UPDATE inbox_item SET read = false WHERE workspace_id = $1`, f.workspaceID)
			}
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				rec := httptest.NewRecorder()
				handler(rec, withURLParam(inboxRequest(http.MethodPost, "/api/inbox/"+id+"/read", f.workspaceID), "id", id))
				mu.Lock()
				codes = append(codes, rec.Code)
				mu.Unlock()
			}(id)
		}
	}
	wg.Wait()
	for _, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("a parallel mark-read returned %d; codes %v", c, codes)
		}
	}
	if got := f.rawUnread(); got != 0 {
		t.Fatalf("raw unread = %d after reading every row", got)
	}
}
