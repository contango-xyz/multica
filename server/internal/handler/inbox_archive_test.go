package handler

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestArchivedInboxPageBeyond200(t *testing.T) {
	ws := dbfx.Workspace(t, "Paged archive", "archive-page-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	// Equal timestamps exercise the ID tie-breaker at every page boundary.
	created := time.Now().UTC().Truncate(time.Microsecond)
	for range 205 {
		issue := dbfx.Issue(t, "Archived", testutil.Cols{"workspace_id": ws})
		dbfx.Insert(t, "inbox_item", testutil.Cols{
			"workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
			"type": "mentioned", "severity": "info", "title": "Archived", "issue_id": issue,
			"archived": true, "created_at": created,
		})
	}
	seen := map[string]bool{}
	cursor := ""
	var firstCursor string
	for pageNumber := 0; ; pageNumber++ {
		if pageNumber > 5 {
			t.Fatal("pagination did not terminate")
		}
		var page archivedInboxPageResponse
		path := "/api/inbox/archived/page?limit=50&cursor=" + url.QueryEscape(cursor)
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, path, ws)).Want(http.StatusOK).JSON(&page)
		for _, item := range page.Items {
			if item.IssueID == nil || seen[*item.IssueID] {
				t.Fatalf("missing or duplicate group: %+v", item)
			}
			seen[*item.IssueID] = true
		}
		if !page.HasMore {
			if page.NextCursor != nil {
				t.Fatal("last page has a cursor")
			}
			break
		}
		if len(page.Items) != 50 || page.NextCursor == nil {
			t.Fatalf("invalid page: %+v", page)
		}
		cursor = *page.NextCursor
		if firstCursor == "" {
			firstCursor = cursor
		}
	}
	if len(seen) != 205 {
		t.Fatalf("got %d groups, want 205", len(seen))
	}
	// Old installed clients retain their capped array response.
	var legacy []InboxItemResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInbox), inboxRequest(http.MethodGet, "/api/inbox/archived", ws)).Want(http.StatusOK).JSON(&legacy)
	if len(legacy) != 200 {
		t.Fatalf("legacy archive = %d, want 200", len(legacy))
	}
	for _, query := range []string{"limit=0", "limit=101", "cursor=broken", "group_id=bad", "unread_only=bad", "statuses=a,,b", "unread_only=true&cursor=" + firstCursor} {
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?"+query, ws)).Want(http.StatusBadRequest)
	}
}

func TestArchivedInboxFiltersAndLookupUseLatestGroup(t *testing.T) {
	ws := dbfx.Workspace(t, "Archive filters", "archive-filter-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	issue := dbfx.Issue(t, "Older matching group", testutil.Cols{"workspace_id": ws, "status": "in_review", "priority": "high"})
	actor := uuid.NewString()
	comment := uuid.NewString()
	old := time.Now().UTC().Add(-time.Hour)
	insert := func(issueID *string, read bool, actorType string, actorID *string, created time.Time, details string, archived bool) string {
		return dbfx.Insert(t, "inbox_item", testutil.Cols{
			"workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
			"type": "mentioned", "severity": "info", "title": "Archive filter", "issue_id": issueID,
			"read": read, "actor_type": actorType, "actor_id": actorID, "archived": archived,
			"created_at": created, "details": details,
		})
	}
	insert(&issue, false, "agent", &actor, old.Add(-time.Minute), `{"comment_id":"`+comment+`"}`, true)
	newest := insert(&issue, true, "system", nil, old, `{}`, true)
	// Fill the newest page with nonmatching groups, so a local filter would miss the match.
	for range 55 {
		insert(nil, false, "agent", &actor, old.Add(time.Minute), `{}`, true)
	}
	get := func(query string) archivedInboxPageResponse {
		var page archivedInboxPageResponse
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?"+query, ws)).Want(http.StatusOK).JSON(&page)
		return page
	}
	page := get("statuses=in_review&priorities=high&actors=system")
	if len(page.Items) != 1 || page.Items[0].ID != newest {
		t.Fatalf("filter lost older match: %+v", page)
	}
	if string(page.Items[0].Details) != `{"comment_id":"`+comment+`"}` {
		t.Fatalf("comment anchor lost: %s", page.Items[0].Details)
	}
	if len(get("group_id="+issue+"&unread_only=true").Items) != 0 {
		t.Fatal("older unread notification matched")
	}
	if len(get("group_id="+issue+"&actors=agent:"+actor).Items) != 0 {
		t.Fatal("older actor matched")
	}
	if len(get("group_id="+issue).Items) != 1 {
		t.Fatal("deep link outside first page did not resolve")
	}
	var facets archivedInboxFacetsResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.GetArchivedInboxFacets), inboxRequest(http.MethodGet, "/api/inbox/archived/facets?actors=system", ws)).Want(http.StatusOK).JSON(&facets)
	if facets.Statuses["in_review"] != 1 || facets.Priorities["high"] != 1 || facets.Actors["agent:"+actor] != 55 || facets.Actors["system"] != 1 || facets.UnreadCount != 0 {
		t.Fatalf("incorrect facets: %+v", facets)
	}
	insert(&issue, false, "system", nil, time.Now(), `{}`, false)
	if len(get("group_id="+issue).Items) != 0 {
		t.Fatal("active issue also appeared in archive")
	}
	// Another recipient and another workspace cannot read this archive, including lookup.
	otherWS := dbfx.Workspace(t, "Other archive", "other-archive-"+uuid.NewString())
	dbfx.Member(t, otherWS, testUserID, "owner")
	var other archivedInboxPageResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?group_id="+issue, otherWS)).Want(http.StatusOK).JSON(&other)
	if len(other.Items) != 0 {
		t.Fatal("cross-workspace archive leak")
	}
	otherUser := dbfx.User(t, "Other recipient", uuid.NewString()+"@example.test")
	dbfx.Member(t, ws, otherUser, "member")
	req := inboxRequest(http.MethodGet, "/api/inbox/archived/page?group_id="+issue, ws)
	req.Header.Set("X-User-ID", otherUser)
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), req).Want(http.StatusOK).JSON(&other)
	if len(other.Items) != 0 {
		t.Fatal("cross-recipient archive leak")
	}
	insert(&issue, false, "system", nil, time.Now(), `{}`, false)
	if len(get("group_id="+issue).Items) != 0 {
		t.Fatal("active issue also appeared in archive")
	}
	for _, handler := range []http.HandlerFunc{testHandler.ListArchivedInboxPage, testHandler.GetArchivedInboxFacets} {
		req := inboxRequest(http.MethodGet, "/api/inbox/archived/page", ws)
		req.Header.Set("X-User-ID", uuid.NewString())
		testutil.Call(t, inboxWorkspaceHandler(handler), req).Want(http.StatusNotFound)
	}
}

// contango smart inbox: a signal refreshed on an issue where someone tagged
// the reader must not stand in for that sender; a signal-only group still
// shows the signal.
func TestArchivedInboxGroupsPreferNonSignalRows(t *testing.T) {
	ws := dbfx.Workspace(t, "Archive signals", "archive-signals-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	agent := uuid.NewString()
	tagged := dbfx.Issue(t, "Tagged", testutil.Cols{"workspace_id": ws})
	signalOnly := dbfx.Issue(t, "Stalled", testutil.Cols{"workspace_id": ws})
	now := time.Now().UTC().Truncate(time.Microsecond)
	insert := func(issue, typ string, at time.Time, cols testutil.Cols) {
		base := testutil.Cols{
			"workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
			"type": typ, "severity": "info", "title": typ, "issue_id": issue,
			"archived": true, "created_at": at,
		}
		for k, v := range cols {
			base[k] = v
		}
		dbfx.Insert(t, "inbox_item", base)
	}
	insert(tagged, "mentioned", now.Add(-time.Hour), testutil.Cols{"actor_type": "agent", "actor_id": agent})
	insert(tagged, "signal", now, testutil.Cols{"actor_type": "system", "details": `{"key":"a","group":"merge"}`})
	insert(signalOnly, "signal", now.Add(-time.Minute), testutil.Cols{"actor_type": "system", "details": `{"key":"b","group":"stalled"}`})

	byIssue := func(items []InboxItemResponse) map[string]string {
		out := map[string]string{}
		for _, it := range items {
			if it.IssueID != nil {
				out[*it.IssueID] = it.Type
			}
		}
		return out
	}
	want := map[string]string{tagged: "mentioned", signalOnly: "signal"}

	var page archivedInboxPageResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page", ws)).
		Want(http.StatusOK).JSON(&page)
	if got := byIssue(page.Items); len(page.Items) != 2 || got[tagged] != want[tagged] || got[signalOnly] != want[signalOnly] {
		t.Fatalf("page representatives = %v, want %v", got, want)
	}

	// The From filter matches the shown sender.
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage),
		inboxRequest(http.MethodGet, "/api/inbox/archived/page?actors="+url.QueryEscape("agent:"+agent), ws)).
		Want(http.StatusOK).JSON(&page)
	if len(page.Items) != 1 || page.Items[0].IssueID == nil || *page.Items[0].IssueID != tagged {
		t.Fatalf("agent filter = %+v", page.Items)
	}

	// The legacy capped list returns the non-signal row for the group.
	var legacy []InboxItemResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInbox), inboxRequest(http.MethodGet, "/api/inbox/archived", ws)).
		Want(http.StatusOK).JSON(&legacy)
	types := map[string][]string{}
	for _, it := range legacy {
		types[*it.IssueID] = append(types[*it.IssueID], it.Type)
	}
	if !contains(types[tagged], "mentioned") || len(types[signalOnly]) != 1 || types[signalOnly][0] != "signal" {
		t.Fatalf("legacy rows = %v", types)
	}
}

