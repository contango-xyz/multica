package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/membergroup"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Contango patch 48: role mention groups.

func groupReq(method, path, ref string, body any, mutate ...func(*http.Request)) *http.Request {
	req := newRequest(method, path, body)
	if ref != "" {
		req = withURLParam(req, "ref", ref)
	}
	for _, m := range mutate {
		m(req)
	}
	// The workspace middleware puts the caller's membership in the context.
	member, err := testHandler.Queries.GetMemberByUserAndWorkspace(context.Background(),
		db.GetMemberByUserAndWorkspaceParams{UserID: parseUUID(req.Header.Get("X-User-ID")), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil {
		panic(err)
	}
	return req.WithContext(middleware.SetMemberContext(req.Context(), testWorkspaceID, member))
}

func resetGroups(t *testing.T) {
	t.Helper()
	dbfx.Exec(t, `DELETE FROM member_group_member WHERE workspace_id = $1`, testWorkspaceID)
	dbfx.Exec(t, `DELETE FROM member_group WHERE workspace_id = $1`, testWorkspaceID)
	t.Cleanup(func() {
		dbfx.Exec(t, `DELETE FROM member_group_member WHERE workspace_id = $1`, testWorkspaceID)
		dbfx.Exec(t, `DELETE FROM member_group WHERE workspace_id = $1`, testWorkspaceID)
	})
}

func createGroup(t *testing.T, handle string, members ...string) membergroup.Group {
	t.Helper()
	var g membergroup.Group
	testutil.Call(t, testHandler.CreateMemberGroup, groupReq("POST", "/api/groups", "", map[string]any{
		"handle": handle, "name": strings.ToUpper(handle), "fallback_user_id": testUserID,
	})).Want(http.StatusCreated).JSON(&g)
	testutil.Call(t, testHandler.SetMemberGroupMembers, groupReq("PUT", "/api/groups/"+handle+"/members", handle,
		map[string]any{"user_ids": members})).Want(http.StatusOK).JSON(&g)
	return g
}

func TestMemberGroupLifecycle(t *testing.T) {
	resetGroups(t)
	ops1 := dbfx.User(t, "Group Ops One", "contango-group-ops1@multica.ai")
	ops2 := dbfx.User(t, "Group Ops Two", "contango-group-ops2@multica.ai")
	dbfx.Member(t, testWorkspaceID, ops1, "member")
	dbfx.Member(t, testWorkspaceID, ops2, "member")
	dbfx.Cleanup(t, `DELETE FROM member_time_off WHERE user_id = $1`, ops1)

	g := createGroup(t, "devops", ops1, ops2)
	if g.Handle != "devops" || len(g.Members) != 2 || g.Members[0].UserID != ops1 || g.Members[1].Handle != "contango-group-ops2" {
		t.Fatalf("unexpected group %+v", g)
	}
	if g.Mention != "[@devops](mention://group/"+g.ID+")" || g.OnDutyVia != membergroup.ViaMembers || len(g.OnDuty) != 2 {
		t.Fatalf("unexpected mention/duty %+v", g)
	}

	// Full-day time off today takes a member off duty; the order decides "first".
	today := time.Now().UTC().Format("2006-01-02")
	dbfx.Exec(t, `INSERT INTO member_time_off (workspace_id, user_id, starts_on, ends_on, source) VALUES ($1, $2, $3, $3, 'manual')`,
		testWorkspaceID, ops1, today)
	var duty struct {
		OnDuty []string `json:"on_duty"`
		Via    string   `json:"via"`
		First  string   `json:"first"`
	}
	testutil.Call(t, testHandler.GetMemberGroupOnDuty, groupReq("GET", "/api/groups/@devops/on-duty", "@DevOps", nil)).
		Want(http.StatusOK).JSON(&duty)
	if duty.First != ops2 || len(duty.OnDuty) != 1 || duty.Via != "members" {
		t.Fatalf("on duty = %+v, want only %s", duty, ops2)
	}

	// Reorder and rename; then archive: it no longer resolves.
	testutil.Call(t, testHandler.SetMemberGroupMembers, groupReq("PUT", "/api/groups/devops/members", "devops",
		map[string]any{"user_ids": []string{ops2, ops1}})).Want(http.StatusOK).JSON(&g)
	if g.Members[0].UserID != ops2 || !g.Members[1].Away {
		t.Fatalf("reorder: %+v", g.Members)
	}
	testutil.Call(t, testHandler.UpdateMemberGroup, groupReq("PATCH", "/api/groups/devops", "devops",
		map[string]any{"name": "DevOps / AWS", "description": "AWS, DNS, test envs"})).Want(http.StatusOK).JSON(&g)
	if g.Name != "DevOps / AWS" || g.FallbackUserID == nil || *g.FallbackUserID != testUserID {
		t.Fatalf("update: %+v", g)
	}
	var list struct {
		Groups []membergroup.Group `json:"groups"`
	}
	testutil.Call(t, testHandler.ListMemberGroups, groupReq("GET", "/api/groups", "", nil)).Want(http.StatusOK).JSON(&list)
	if len(list.Groups) != 1 || list.Groups[0].ID != g.ID {
		t.Fatalf("list: %+v", list.Groups)
	}
	testutil.Call(t, testHandler.ArchiveMemberGroup, groupReq("DELETE", "/api/groups/devops", "devops", nil)).Want(http.StatusNoContent)
	testutil.Call(t, testHandler.GetMemberGroup, groupReq("GET", "/api/groups/devops", "devops", nil)).Want(http.StatusNotFound)
	// The handle is free again once archived.
	createGroup(t, "devops", ops1)
}

func TestMemberGroupRefusals(t *testing.T) {
	resetGroups(t)
	plain := dbfx.User(t, "Group Plain", "contango-group-plain@multica.ai")
	dbfx.Member(t, testWorkspaceID, plain, "member")
	createGroup(t, "fe")
	agent := dbfx.Agent(t, "Group Clash", "")
	_ = agent

	for name, tc := range map[string]struct {
		body map[string]any
		want int
	}{
		"bad shape":       {map[string]any{"handle": "Dev Ops", "name": "x"}, http.StatusBadRequest},
		"reserved":        {map[string]any{"handle": "all", "name": "x"}, http.StatusBadRequest},
		"person's handle": {map[string]any{"handle": "contango-group-plain", "name": "x"}, http.StatusConflict},
		"agent's name":    {map[string]any{"handle": "group-clash", "name": "x"}, http.StatusConflict},
		"taken":           {map[string]any{"handle": "fe", "name": "x"}, http.StatusConflict},
		"no name":         {map[string]any{"handle": "ux"}, http.StatusBadRequest},
		"stranger fallback": {map[string]any{"handle": "ux", "name": "x",
			"fallback_user_id": "00000000-0000-0000-0000-000000000001"}, http.StatusBadRequest},
	} {
		t.Run(name, func(t *testing.T) {
			testutil.Call(t, testHandler.CreateMemberGroup, groupReq("POST", "/api/groups", "", tc.body)).Want(tc.want)
		})
	}
	t.Run("stranger member", func(t *testing.T) {
		testutil.Call(t, testHandler.SetMemberGroupMembers, groupReq("PUT", "/api/groups/fe/members", "fe",
			map[string]any{"user_ids": []string{"00000000-0000-0000-0000-000000000001"}})).Want(http.StatusBadRequest)
	})
	t.Run("plain members can read, not change", func(t *testing.T) {
		asPlain := func(r *http.Request) { r.Header.Set("X-User-ID", plain) }
		testutil.Call(t, testHandler.ListMemberGroups, groupReq("GET", "/api/groups", "", nil, asPlain)).Want(http.StatusOK)
		testutil.Call(t, testHandler.CreateMemberGroup, groupReq("POST", "/api/groups", "", map[string]any{"handle": "ux", "name": "x"}, asPlain)).
			Want(http.StatusForbidden)
		testutil.Call(t, testHandler.SetMemberGroupMembers, groupReq("PUT", "/api/groups/fe/members", "fe",
			map[string]any{"user_ids": []string{plain}}, asPlain)).Want(http.StatusForbidden)
	})
}

// An ask to a group mentions the group last; any member's reply in the thread answers it.
func TestIssueAskToGroup(t *testing.T) {
	resetGroups(t)
	ops := dbfx.User(t, "Group Ask Ops", "contango-group-askops@multica.ai")
	dbfx.Member(t, testWorkspaceID, ops, "member")
	g := createGroup(t, "devops", ops)
	f := newAskFixture(t)
	out := f.create(t, f.createReq(map[string]any{"addressee_type": "group", "addressee_id": g.ID}))
	if out.Ask.AddresseeType != "group" || out.Ask.AddresseeID == nil || *out.Ask.AddresseeID != g.ID {
		t.Fatalf("unexpected ask %+v", out.Ask)
	}
	if !strings.HasSuffix(out.Comment.Content, "[@devops](mention://group/"+g.ID+")") {
		t.Fatalf("comment does not end with the group mention:\n%s", out.Comment.Content)
	}
	f.comment(t, map[string]any{"content": "done", "parent_id": out.Comment.ID}, func(r *http.Request) { r.Header.Set("X-User-ID", ops) })
	if state, via := askState(t, out.Ask.ID); state != "answered" || via != "comment" {
		t.Fatalf("got %s/%s", state, via)
	}
	testutil.Call(t, testHandler.CreateIssueAsk, withURLParam(f.createReq(map[string]any{
		"addressee_type": "group", "addressee_id": "00000000-0000-0000-0000-000000000001"}), "id", f.issueID)).
		Want(http.StatusBadRequest)
}

// A @group mention is a person mention for routing: it stops the lead-agent fallback.
func TestHasMemberMentionCountsGroups(t *testing.T) {
	if !hasMemberMention(util.ParseMentions("[@devops](mention://group/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa) please")) {
		t.Fatal("group mention not counted as a member mention")
	}
}
