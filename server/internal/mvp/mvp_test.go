package mvp

import (
	"reflect"
	"testing"
	"time"
)

var now = time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)

var cats = map[string]string{
	"backlog": "unstarted", "todo": "unstarted", "in_progress": "started", "in_review": "started",
	"blocked": "started", "held": "started", "done": "done", "cancelled": "closed",
}

func iss(id, parent string, n int32, status string, rel Release) Issue {
	return Issue{ID: id, ParentID: parent, Number: n, Identifier: "CTG-" + itoa(n), Title: id, Status: status,
		Release: rel, CreatedAt: now.AddDate(0, -2, 0)}
}

func itoa(n int32) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

func input(issues []Issue, edges []Edge) Input {
	return Input{Now: now, Issues: issues, Edges: edges, Categories: cats, HeldStatus: "held",
		BlockedState: "blocked", IdleAfter: 24 * time.Hour, Days: 30}
}

func ids(refs []Ref) []string {
	out := []string{}
	for _, r := range refs {
		out = append(out, r.ID)
	}
	return out
}

func TestScopeInheritsAndExcludes(t *testing.T) {
	issues := []Issue{
		iss("epic", "", 1, "in_progress", ReleaseMVP),
		iss("child", "epic", 2, "todo", ReleaseNone),        // inherits MVP
		iss("grand", "child", 3, "todo", ReleaseNone),       // inherits through two levels
		iss("post", "epic", 4, "todo", ReleaseOther),        // explicitly another release
		iss("underpost", "post", 5, "todo", ReleaseNone),    // out with its parent
		iss("loose", "", 6, "todo", ReleaseNone),            // untagged top-level: out
		iss("home", "", 7, "backlog", ReleaseMVP),           // the home card is never scope
		iss("mvpunderother", "post", 8, "todo", ReleaseMVP), // tagged MVP under Post-MVP: in, and a pillar
	}
	got := Scope(issues, "home")
	want := map[string]bool{"epic": true, "child": true, "grand": true, "mvpunderother": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scope = %v, want %v", got, want)
	}
	in := input(issues, nil)
	in.HomeIssueID = "home"
	r := Compute(in)
	var pillars []string
	for _, p := range r.Pillars {
		pillars = append(pillars, p.Issue.ID)
	}
	// epic is a pillar; mvpunderother has no sub-cards, so it is a standalone card.
	if len(pillars) != 1 || pillars[0] != "epic" || r.Standalone.Total != 1 || r.Standalone.OpenItems[0].ID != "mvpunderother" {
		t.Fatalf("pillars = %v standalone = %+v", pillars, r.Standalone)
	}
}

func TestScopeSurvivesParentCycle(t *testing.T) {
	issues := []Issue{iss("a", "b", 1, "todo", ReleaseNone), iss("b", "a", 2, "todo", ReleaseNone)}
	if got := Scope(issues, ""); len(got) != 0 {
		t.Fatalf("scope = %v", got)
	}
}

func TestProgressCountsLeavesPerPillar(t *testing.T) {
	issues := []Issue{
		iss("p1", "", 1, "in_progress", ReleaseMVP),
		iss("a", "p1", 2, "done", ReleaseNone),
		iss("b", "p1", 3, "todo", ReleaseNone),
		iss("sub", "p1", 4, "in_progress", ReleaseNone), // a sub-epic: its leaves count, not itself
		iss("c", "sub", 5, "held", ReleaseNone),
		iss("d", "sub", 6, "cancelled", ReleaseNone),
		iss("p2", "", 7, "done", ReleaseMVP), // no sub-cards: standalone
	}
	r := Compute(input(issues, nil))
	if r.Totals.Total != 4 || r.Totals.Open != 2 || r.Totals.Done != 2 || r.Totals.Cancelled != 1 {
		t.Fatalf("totals = %+v", r.Totals)
	}
	if len(r.Pillars) != 1 || r.Pillars[0].Issue.ID != "p1" {
		t.Fatalf("pillars order = %+v", r.Pillars)
	}
	p1 := r.Pillars[0]
	if p1.Total != 3 || p1.Open != 2 || p1.Done != 1 || p1.ByStatus["held"] != 1 || p1.ByStatus["todo"] != 1 {
		t.Fatalf("p1 = %+v", p1.Counts)
	}
	if got := ids(p1.OpenItems); !reflect.DeepEqual(got, []string{"b", "c"}) {
		t.Fatalf("open items = %v", got)
	}
	if st := r.Standalone; st.Total != 1 || st.Done != 1 || st.Open != 0 || len(st.OpenItems) != 0 {
		t.Fatalf("standalone = %+v", st)
	}
}

func TestCriticalPathsLongestChains(t *testing.T) {
	issues := []Issue{
		iss("e", "", 1, "in_progress", ReleaseMVP),
		iss("a", "e", 2, "todo", ReleaseNone),
		iss("b", "e", 3, "todo", ReleaseNone),
		iss("c", "e", 4, "todo", ReleaseNone),
		iss("d", "e", 5, "todo", ReleaseNone),
		iss("x", "", 6, "in_progress", ReleaseOther), // an outside blocker stays on the chain
		iss("y", "e", 7, "todo", ReleaseNone),
		iss("z", "e", 8, "todo", ReleaseNone),
		iss("closed", "e", 9, "done", ReleaseNone),
	}
	edges := []Edge{
		{Blocked: "b", Blocker: "a"}, {Blocked: "c", Blocker: "b"}, {Blocked: "d", Blocker: "c"}, // a→b→c→d
		{Blocked: "a", Blocker: "x"},      // x→a
		{Blocked: "z", Blocker: "y"},      // y→z
		{Blocked: "y", Blocker: "closed"}, // a done blocker is no edge
	}
	r := Compute(input(issues, edges))
	if len(r.CriticalPaths) != 2 {
		t.Fatalf("chains = %d", len(r.CriticalPaths))
	}
	if got := ids(r.CriticalPaths[0].Issues); !reflect.DeepEqual(got, []string{"x", "a", "b", "c", "d"}) {
		t.Fatalf("chain 0 = %v", got)
	}
	if got := ids(r.CriticalPaths[1].Issues); !reflect.DeepEqual(got, []string{"y", "z"}) {
		t.Fatalf("chain 1 = %v", got)
	}
	var a Ref
	for _, it := range r.Pillars[0].OpenItems {
		if it.ID == "a" {
			a = it
		}
	}
	if !a.Critical || a.Blocks != 3 || len(a.BlockedBy) != 1 || a.BlockedBy[0].ID != "x" {
		t.Fatalf("a = %+v", a)
	}
	if r.Pillars[0].OpenItems[0].ID != "a" { // critical first, then most dependents
		t.Fatalf("first open item = %s", r.Pillars[0].OpenItems[0].ID)
	}
}

func TestCriticalPathCycleDoesNotHang(t *testing.T) {
	issues := []Issue{iss("a", "", 1, "todo", ReleaseMVP), iss("b", "", 2, "todo", ReleaseMVP), iss("c", "", 3, "todo", ReleaseMVP)}
	edges := []Edge{{Blocked: "a", Blocker: "b"}, {Blocked: "b", Blocker: "a"}, {Blocked: "c", Blocker: "a"}}
	r := Compute(input(issues, edges))
	if len(r.CriticalPaths) == 0 {
		t.Fatal("expected a chain")
	}
}

func TestBurndownReconstructsHistory(t *testing.T) {
	issues := []Issue{
		iss("p", "", 1, "in_progress", ReleaseMVP),
		iss("a", "p", 2, "done", ReleaseNone),
		iss("b", "p", 3, "done", ReleaseNone),
		iss("c", "p", 4, "todo", ReleaseNone),
		iss("new", "p", 5, "todo", ReleaseNone),
	}
	issues[4].CreatedAt = now.AddDate(0, 0, -3)
	in := input(issues, nil)
	in.Changes = []StatusChange{
		{IssueID: "a", At: now.AddDate(0, 0, -10), From: "todo", To: "in_progress"},
		{IssueID: "a", At: now.AddDate(0, 0, -5), From: "in_progress", To: "done"},
		{IssueID: "b", At: now.AddDate(0, 0, -2), From: "in_review", To: "done"},
		{IssueID: "c", At: now.AddDate(0, 0, -20), From: "done", To: "todo"}, // reopened
	}
	r := Compute(in)
	if len(r.Burndown) != 31 {
		t.Fatalf("points = %d", len(r.Burndown))
	}
	first, last := r.Burndown[0], r.Burndown[len(r.Burndown)-1]
	if first.Open != 2 || first.Done != 1 { // a, b open; c done; new not yet created
		t.Fatalf("first = %+v", first)
	}
	if last.Open != 2 || last.Done != 2 {
		t.Fatalf("last = %+v", last)
	}
	if r.ETA.Open != 2 || r.ETA.Done7 != 2 || r.ETA.Done14 != 2 || r.ETA.Rate7 != 0.29 {
		t.Fatalf("eta = %+v", r.ETA)
	}
	if r.ETA.Days7 == nil || *r.ETA.Days7 != 7 || *r.ETA.Date7 != "2026-11-13" {
		t.Fatalf("eta days = %v %v", r.ETA.Days7, r.ETA.Date7)
	}
}

func TestETAWithoutThroughputIsUnknown(t *testing.T) {
	r := Compute(input([]Issue{iss("a", "", 1, "todo", ReleaseMVP)}, nil))
	if r.ETA.Date7 != nil || r.ETA.Date14 != nil || r.ETA.Open != 1 {
		t.Fatalf("eta = %+v", r.ETA)
	}
}

func TestStuck(t *testing.T) {
	recent, old := now.Add(-2*time.Hour), now.Add(-30*time.Hour)
	issues := []Issue{
		iss("p", "", 1, "in_progress", ReleaseMVP),
		iss("held", "p", 2, "held", ReleaseNone),
		iss("blk", "p", 3, "blocked", ReleaseNone),
		iss("blkok", "p", 4, "blocked", ReleaseNone),
		iss("idle", "p", 5, "in_progress", ReleaseNone),
		iss("busy", "p", 6, "in_progress", ReleaseNone),
		iss("never", "p", 7, "in_review", ReleaseNone),
		iss("parked", "p", 8, "todo", ReleaseNone),
		iss("blocker", "p", 9, "todo", ReleaseNone),
	}
	issues[4].LastRunAt, issues[5].LastRunAt = &old, &recent
	r := Compute(input(issues, []Edge{{Blocked: "blkok", Blocker: "blocker"}}))
	if got := ids(r.Stuck.Held); !reflect.DeepEqual(got, []string{"held"}) {
		t.Fatalf("held = %v", got)
	}
	if got := ids(r.Stuck.BlockedNoBlocker); !reflect.DeepEqual(got, []string{"blk"}) {
		t.Fatalf("blocked = %v", got)
	}
	if got := ids(r.Stuck.Idle); !reflect.DeepEqual(got, []string{"idle", "never"}) {
		t.Fatalf("idle = %v", got)
	}
}

func TestAsksGroupedByHuman(t *testing.T) {
	alice, bob, carol := "aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002", "cccccccc-0000-0000-0000-000000000003"
	issues := []Issue{
		iss("p", "", 1, "in_progress", ReleaseMVP),
		iss("ask1", "p", 2, "in_progress", ReleaseNone),
		iss("ask2", "p", 3, "in_progress", ReleaseNone),
		iss("w1", "p", 4, "todo", ReleaseNone),
		iss("w2", "p", 5, "todo", ReleaseNone),
		iss("noflag", "p", 6, "in_progress", ReleaseNone),
		iss("out", "", 7, "in_progress", ReleaseOther),
		iss("home", "", 8, "backlog", ReleaseOther),
	}
	issues[0].Responsible = alice
	issues[1].NeedsHuman, issues[2].NeedsHuman, issues[6].NeedsHuman = true, true, true
	issues[2].Responsible = bob
	in := input(issues, []Edge{{Blocked: "w1", Blocker: "ask1"}, {Blocked: "w2", Blocker: "w1"}})
	in.HomeIssueID = "home"
	in.Members = map[string]bool{alice: true, bob: true, carol: true}
	t0 := now.Add(-time.Hour)
	in.Asks = []Ask{
		{IssueID: "ask1", CommentID: "c1", Kind: "human", Content: "**[NEEDS HUMAN]** Approve the design\n\nmore", CreatedAt: t0},
		// names carol explicitly: hers, whatever the card says
		{IssueID: "ask2", CommentID: "c2", Kind: "human", Content: "**[NEEDS HUMAN]** Merge it [@Carol](mention://member/" + carol + ")", CreatedAt: t0},
		{IssueID: "noflag", CommentID: "c3", Kind: "human", Content: "**[NEEDS HUMAN]** x", CreatedAt: t0},
		{IssueID: "out", CommentID: "c4", Kind: "human", Content: "**[NEEDS HUMAN]** y", CreatedAt: t0},
		{IssueID: "home", CommentID: "c5", Kind: "operator", Content: "**[NEEDS OPERATOR]** Which chains?", CreatedAt: t0},
		{IssueID: "p", CommentID: "c6", Kind: "human", Content: "**[NEEDS HUMAN]** Pillar ask", CreatedAt: t0.Add(time.Minute)},
		{IssueID: "p", CommentID: "c7", Kind: "operator", Content: "**[NEEDS OPERATOR]** answered", CreatedAt: t0, Answered: true},
	}
	in.Signals = []Signal{{InboxItemID: "inbox-1", RecipientID: bob, IssueID: "ask1", CommentID: "c1",
		Replies: []SignalReply{{Label: "Approve: agree", Content: "agree"}}}}
	r := Compute(in)
	if len(r.Humans) != 2 {
		t.Fatalf("humans = %+v", r.Humans)
	}
	// ask1 routes to bob through its smart-inbox signal (parent's Responsible would be alice)
	// and holds w1 and w2 downstream: three cards.
	if g := r.Humans[0]; g.RecipientID != bob || g.CardsBlocked != 3 || len(g.Asks) != 1 ||
		g.Asks[0].InboxItemID != "inbox-1" || len(g.Asks[0].Replies) != 1 || g.Asks[0].Blocks != 2 ||
		g.Asks[0].Excerpt != "Approve the design" {
		t.Fatalf("group 0 = %+v", g)
	}
	if g := r.Humans[1]; g.RecipientID != carol || g.CardsBlocked != 1 {
		t.Fatalf("group 1 = %+v", g)
	}
	// Agent questions: the home card's and the pillar's open asks, newest first; the answered one is gone.
	var qs []string
	for _, q := range r.AgentQuestions {
		qs = append(qs, q.CommentID)
	}
	if !reflect.DeepEqual(qs, []string{"c6", "c5"}) {
		t.Fatalf("questions = %v", qs)
	}
}

func TestExcerpt(t *testing.T) {
	if got := Excerpt("  **[NEEDS HUMAN]** Merge PR #1: thing\n\nbody"); got != "Merge PR #1: thing" {
		t.Fatalf("excerpt = %q", got)
	}
	if got := Excerpt("**[NEEDS HUMAN]** See the [admission ask](https://x/y#c) for [@Dele](mention://member/abc)"); got != "See the admission ask for @Dele" {
		t.Fatalf("excerpt = %q", got)
	}
}
