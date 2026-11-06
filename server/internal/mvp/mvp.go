// Package mvp computes the MVP page (contango, patch 19): what is in MVP scope,
// progress per pillar, the critical path(s) through blocked-by edges, a burndown
// rebuilt from status history, and what is in the way. Pure: the handler loads
// the rows, this package does the in-memory work, so it is tested without a DB.
package mvp

import (
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Release tags an issue's Release property relative to the MVP option.
type Release int

const (
	ReleaseNone  Release = iota // property unset: inherits its parent's scope
	ReleaseMVP                  // the MVP option
	ReleaseOther                // any other option: out of scope, with its subtree
)

// Issue is one workspace issue as the computation needs it.
type Issue struct {
	ID           string
	ParentID     string
	Number       int32
	Identifier   string
	Title        string
	Status       string
	Priority     string
	AssigneeType string
	AssigneeID   string
	// Responsible is the user id of the "Responsible human" property, "" if unset.
	Responsible string
	// CreatorMember is the creator's user id when a member created the issue.
	CreatorMember string
	Release       Release
	NeedsHuman    bool
	CreatedAt     time.Time
	// LastRunAt is the newest agent run on the issue (now while one is active).
	LastRunAt *time.Time
}

// Edge says Blocked cannot finish before Blocker.
type Edge struct {
	Blocked string
	Blocker string
}

// StatusChange is one status_changed activity.
type StatusChange struct {
	IssueID string
	At      time.Time
	From    string
	To      string
}

// Ask is the latest [NEEDS HUMAN] or [NEEDS OPERATOR] comment of one kind on an
// issue, with whether someone answered it since.
type Ask struct {
	IssueID   string
	CommentID string
	Kind      string // "human" or "operator"
	Content   string
	CreatedAt time.Time
	Answered  bool
}

// Signal is a smart-inbox entry (patch 14) raised for an ask; it carries the
// feeder's recipient and, with patch 18, one-tap replies.
type Signal struct {
	InboxItemID string
	RecipientID string
	IssueID     string
	CommentID   string
	Replies     []SignalReply
}

// SignalReply is one one-tap answer; Index is its position in the signal's
// replies, which POST /api/inbox/{id}/signal-reply takes.
type SignalReply struct {
	Label   string `json:"label"`
	Content string `json:"content"`
	Index   int    `json:"index"`
}

// Input is everything the page is computed from.
type Input struct {
	Now          time.Time
	Issues       []Issue
	Edges        []Edge
	Changes      []StatusChange // status changes since Now - Days (older ones are ignored)
	Asks         []Ask
	Signals      []Signal
	Categories   map[string]string // status key -> unstarted | started | done | closed
	HomeIssueID  string
	Members      map[string]bool // workspace member user ids that count as people
	HeldStatus   string
	BlockedState string
	IdleAfter    time.Duration
	Days         int
}

// Ref is an issue as the page lists it.
type Ref struct {
	ID           string   `json:"id"`
	Identifier   string   `json:"identifier"`
	Number       int32    `json:"number"`
	Title        string   `json:"title"`
	Status       string   `json:"status"`
	Priority     string   `json:"priority"`
	AssigneeType string   `json:"assignee_type,omitempty"`
	AssigneeID   string   `json:"assignee_id,omitempty"`
	Responsible  string   `json:"responsible_id,omitempty"`
	ParentID     string   `json:"parent_id,omitempty"`
	BlockedBy    []BRef   `json:"blocked_by"`
	Blocks       int      `json:"blocks"` // open MVP cards waiting on it, directly or downstream
	Critical     bool     `json:"on_critical_path"`
	LastRunAt    *string  `json:"last_run_at"`
	Flags        []string `json:"flags,omitempty"` // held | blocked_no_blocker | idle | needs_human
}

// BRef is an open blocker.
type BRef struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Status     string `json:"status"`
}

type Counts struct {
	Total     int            `json:"total"`
	Open      int            `json:"open"`
	Done      int            `json:"done"`
	Cancelled int            `json:"cancelled"`
	ByStatus  map[string]int `json:"by_status"` // open cards only
}

// Group is a set of leaf cards with their counts and open cards.
type Group struct {
	Counts
	OpenItems []Ref `json:"open_items"`
}

// Pillar is a top-level MVP issue with MVP sub-cards (an epic).
type Pillar struct {
	Issue Ref `json:"issue"`
	Group
}

type Chain struct {
	Issues []Ref `json:"issues"`
}

type BurnPoint struct {
	Date string `json:"date"`
	Open int    `json:"open"`
	Done int    `json:"done"`
}

type ETA struct {
	Open   int      `json:"open"`
	Done7  int      `json:"done_7d"`
	Done14 int      `json:"done_14d"`
	Rate7  float64  `json:"rate_7d"`
	Rate14 float64  `json:"rate_14d"`
	Date7  *string  `json:"eta_7d"`
	Date14 *string  `json:"eta_14d"`
	Days7  *float64 `json:"days_7d"`
	Days14 *float64 `json:"days_14d"`
}

type HumanAsk struct {
	Issue       Ref           `json:"issue"`
	CommentID   string        `json:"comment_id"`
	Kind        string        `json:"kind"`
	Excerpt     string        `json:"excerpt"`
	CreatedAt   string        `json:"created_at"`
	RecipientID string        `json:"recipient_id"`
	Blocks      int           `json:"blocks"`
	InboxItemID string        `json:"inbox_item_id,omitempty"`
	Replies     []SignalReply `json:"replies"`
}

type HumanGroup struct {
	RecipientID  string     `json:"recipient_id"` // "" when nobody could be named
	CardsBlocked int        `json:"cards_blocked"`
	Asks         []HumanAsk `json:"asks"`
}

type Stuck struct {
	Held             []Ref `json:"held"`
	BlockedNoBlocker []Ref `json:"blocked_no_blocker"`
	Idle             []Ref `json:"idle"`
}

type Report struct {
	Totals         Counts       `json:"totals"`
	Pillars        []Pillar     `json:"pillars"`
	Standalone     Group        `json:"standalone"` // top-level MVP cards without sub-cards
	CriticalPaths  []Chain      `json:"critical_paths"`
	Burndown       []BurnPoint  `json:"burndown"`
	ETA            ETA          `json:"eta"`
	Humans         []HumanGroup `json:"humans"`
	Stuck          Stuck        `json:"stuck"`
	AgentQuestions []HumanAsk   `json:"agent_questions"`
}

type state int

const (
	stOpen state = iota
	stDone
	stClosed
)

func (in *Input) state(status string) state {
	switch in.Categories[status] {
	case "done":
		return stDone
	case "closed":
		return stClosed
	case "unstarted", "started":
		return stOpen
	}
	// Unknown keys: the system ones by name, anything else counts as open.
	switch status {
	case "done":
		return stDone
	case "cancelled":
		return stClosed
	}
	return stOpen
}

type computer struct {
	in         *Input
	byID       map[string]*Issue
	scope      map[string]bool
	children   map[string][]string // in-scope children of in-scope issues
	blockers   map[string][]string // open blockers of open issues
	blocked    map[string][]string // open issues waiting on an open issue
	dependents map[string]int
	critical   map[string]bool
}

// Scope returns the ids of the issues in MVP scope: tagged MVP, or untagged
// under an in-scope parent. A subtree tagged with another release is out.
func Scope(issues []Issue, homeID string) map[string]bool {
	byID := make(map[string]*Issue, len(issues))
	for i := range issues {
		byID[issues[i].ID] = &issues[i]
	}
	memo := map[string]bool{}
	visiting := map[string]bool{}
	var in func(id string) bool
	in = func(id string) bool {
		if v, ok := memo[id]; ok {
			return v
		}
		is := byID[id]
		if is == nil || visiting[id] {
			return false
		}
		visiting[id] = true
		v := false
		switch is.Release {
		case ReleaseMVP:
			v = true
		case ReleaseNone:
			v = is.ParentID != "" && in(is.ParentID)
		}
		delete(visiting, id)
		memo[id] = v
		return v
	}
	out := map[string]bool{}
	for i := range issues {
		if issues[i].ID != homeID && in(issues[i].ID) {
			out[issues[i].ID] = true
		}
	}
	return out
}

// Compute builds the page.
func Compute(in Input) Report {
	if in.Days <= 0 {
		in.Days = 30
	}
	if in.IdleAfter <= 0 {
		in.IdleAfter = 24 * time.Hour
	}
	c := &computer{in: &in, byID: map[string]*Issue{}, children: map[string][]string{},
		blockers: map[string][]string{}, blocked: map[string][]string{}}
	for i := range in.Issues {
		c.byID[in.Issues[i].ID] = &in.Issues[i]
	}
	c.scope = Scope(in.Issues, in.HomeIssueID)
	for id := range c.scope {
		if p := c.byID[id].ParentID; p != "" && c.scope[p] {
			c.children[p] = append(c.children[p], id)
		}
	}
	for _, e := range in.Edges {
		a, b := c.byID[e.Blocked], c.byID[e.Blocker]
		if a == nil || b == nil || a.ID == b.ID || in.state(a.Status) != stOpen || in.state(b.Status) != stOpen {
			continue
		}
		c.blockers[a.ID] = append(c.blockers[a.ID], b.ID)
		c.blocked[b.ID] = append(c.blocked[b.ID], a.ID)
	}
	for _, m := range []map[string][]string{c.blockers, c.blocked, c.children} {
		for k := range m {
			sort.Slice(m[k], func(i, j int) bool { return c.byID[m[k][i]].Number < c.byID[m[k][j]].Number })
		}
	}
	c.dependents = map[string]int{}
	for id := range c.byID {
		if in.state(c.byID[id].Status) == stOpen {
			c.dependents[id] = len(c.downstream([]string{id}))
		}
	}

	var r Report
	r.CriticalPaths = c.criticalPaths()
	c.critical = map[string]bool{}
	for _, ch := range r.CriticalPaths {
		for _, x := range ch.Issues {
			c.critical[x.ID] = true
		}
	}
	for i := range r.CriticalPaths {
		for j := range r.CriticalPaths[i].Issues {
			r.CriticalPaths[i].Issues[j].Critical = true
		}
	}
	r.Totals, r.Pillars, r.Standalone = c.progress()
	r.Burndown, r.ETA = c.burndown(r.Totals.Open)
	r.Stuck = c.stuck()
	r.Humans, r.AgentQuestions = c.asks()
	return r
}

// leaf: an in-scope issue with no in-scope children. Counts use leaves so an
// epic and its cards are not counted twice.
func (c *computer) leaf(id string) bool { return len(c.children[id]) == 0 }

// downstream: open in-scope issues transitively waiting on any of ids (ids excluded).
func (c *computer) downstream(ids []string) map[string]bool {
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	out := map[string]bool{}
	stack := append([]string(nil), ids...)
	for len(stack) > 0 {
		x := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, y := range c.blocked[x] {
			if seen[y] {
				continue
			}
			seen[y] = true
			if c.scope[y] {
				out[y] = true
			}
			stack = append(stack, y)
		}
	}
	return out
}

func (c *computer) ref(id string) Ref {
	is := c.byID[id]
	r := Ref{ID: is.ID, Identifier: is.Identifier, Number: is.Number, Title: is.Title, Status: is.Status,
		Priority: is.Priority, AssigneeType: is.AssigneeType, AssigneeID: is.AssigneeID,
		Responsible: is.Responsible, ParentID: is.ParentID, BlockedBy: []BRef{},
		Blocks: c.dependents[id], Critical: c.critical[id]}
	for _, b := range c.blockers[id] {
		bi := c.byID[b]
		r.BlockedBy = append(r.BlockedBy, BRef{ID: bi.ID, Identifier: bi.Identifier, Status: bi.Status})
	}
	if is.LastRunAt != nil {
		s := is.LastRunAt.UTC().Format(time.RFC3339)
		r.LastRunAt = &s
	}
	if c.scope[id] {
		if is.Status == c.in.HeldStatus {
			r.Flags = append(r.Flags, "held")
		}
		if c.blockedNoBlocker(id) {
			r.Flags = append(r.Flags, "blocked_no_blocker")
		}
		if c.idle(id) {
			r.Flags = append(r.Flags, "idle")
		}
		if is.NeedsHuman {
			r.Flags = append(r.Flags, "needs_human")
		}
	}
	return r
}

func (c *computer) blockedNoBlocker(id string) bool {
	is := c.byID[id]
	return is.Status == c.in.BlockedState && len(c.blockers[id]) == 0
}

// idle: an open, started leaf card (not held or blocked) with no agent run for
// IdleAfter. Epics and parked cards (backlog, todo) are not expected to run.
func (c *computer) idle(id string) bool {
	is := c.byID[id]
	if !c.leaf(id) || c.in.Categories[is.Status] != "started" || is.Status == c.in.HeldStatus || is.Status == c.in.BlockedState {
		return false
	}
	return is.LastRunAt == nil || c.in.Now.Sub(*is.LastRunAt) >= c.in.IdleAfter
}

func (c *computer) count(ids []string) Counts {
	k := Counts{ByStatus: map[string]int{}}
	for _, id := range ids {
		switch c.in.state(c.byID[id].Status) {
		case stOpen:
			k.Open++
			k.ByStatus[c.byID[id].Status]++
		case stDone:
			k.Done++
		case stClosed:
			k.Cancelled++
		}
	}
	k.Total = k.Open + k.Done
	return k
}

func (c *computer) subtreeLeaves(id string) []string {
	var out []string
	var walk func(x string, depth int)
	walk = func(x string, depth int) {
		if depth > 64 {
			return
		}
		if c.leaf(x) {
			out = append(out, x)
			return
		}
		for _, y := range c.children[x] {
			walk(y, depth+1)
		}
	}
	walk(id, 0)
	return out
}

func (c *computer) sortRefs(ids []string) {
	sort.Slice(ids, func(i, j int) bool {
		a, b := c.byID[ids[i]], c.byID[ids[j]]
		if c.critical[a.ID] != c.critical[b.ID] {
			return c.critical[a.ID]
		}
		if c.dependents[a.ID] != c.dependents[b.ID] {
			return c.dependents[a.ID] > c.dependents[b.ID]
		}
		return a.Number < b.Number
	})
}

func (c *computer) group(ls []string) Group {
	g := Group{Counts: c.count(ls), OpenItems: []Ref{}}
	var open []string
	for _, l := range ls {
		if c.in.state(c.byID[l].Status) == stOpen {
			open = append(open, l)
		}
	}
	c.sortRefs(open)
	for _, l := range open {
		g.OpenItems = append(g.OpenItems, c.ref(l))
	}
	return g
}

func (c *computer) progress() (Counts, []Pillar, Group) {
	var leaves, pillars, standalone []string
	for id := range c.scope {
		if c.leaf(id) {
			leaves = append(leaves, id)
		}
		if p := c.byID[id].ParentID; p == "" || !c.scope[p] {
			if c.leaf(id) {
				standalone = append(standalone, id)
			} else {
				pillars = append(pillars, id)
			}
		}
	}
	totals := c.count(leaves)
	out := make([]Pillar, 0, len(pillars))
	for _, p := range pillars {
		out = append(out, Pillar{Issue: c.ref(p), Group: c.group(c.subtreeLeaves(p))})
	}
	// Open pillars first, most open work first; finished ones last.
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Open == 0) != (b.Open == 0) {
			return a.Open > 0
		}
		if a.Open != b.Open {
			return a.Open > b.Open
		}
		return a.Issue.Number < b.Issue.Number
	})
	return totals, out, c.group(standalone)
}

// criticalPaths: the longest chains of open work through blocked-by edges that
// end at an open MVP card. Blockers outside MVP scope stay on the chain: they
// hold MVP work all the same. Up to three, longest first, each at least two long,
// none mostly repeating a longer one.
func (c *computer) criticalPaths() []Chain {
	depth := map[string]int{}
	prev := map[string]string{}
	visiting := map[string]bool{}
	var walk func(id string) int
	walk = func(id string) int {
		if d, ok := depth[id]; ok {
			return d
		}
		if visiting[id] { // a cycle in old data: cut it here
			return 0
		}
		visiting[id] = true
		best, from := 0, ""
		for _, b := range c.blockers[id] {
			if d := walk(b); d > best {
				best, from = d, b
			}
		}
		delete(visiting, id)
		depth[id] = best + 1
		if from != "" {
			prev[id] = from
		}
		return best + 1
	}
	var ends []string
	for id := range c.scope {
		if c.in.state(c.byID[id].Status) != stOpen || len(c.blockers[id]) == 0 {
			continue
		}
		terminal := true
		for _, y := range c.blocked[id] {
			if c.scope[y] {
				terminal = false
				break
			}
		}
		if terminal {
			walk(id)
			ends = append(ends, id)
		}
	}
	sort.Slice(ends, func(i, j int) bool {
		if depth[ends[i]] != depth[ends[j]] {
			return depth[ends[i]] > depth[ends[j]]
		}
		return c.byID[ends[i]].Number < c.byID[ends[j]].Number
	})
	var out []Chain
	used := map[string]bool{}
	for _, e := range ends {
		if len(out) == 3 {
			break
		}
		var ids []string
		for x := e; x != ""; x = prev[x] {
			ids = append(ids, x)
			if len(ids) > len(c.byID) {
				break
			}
		}
		if len(ids) < 2 {
			continue
		}
		overlap := 0
		for _, x := range ids {
			if used[x] {
				overlap++
			}
		}
		if overlap*2 > len(ids) {
			continue
		}
		ch := Chain{}
		for i := len(ids) - 1; i >= 0; i-- { // first blocker first
			used[ids[i]] = true
			ch.Issues = append(ch.Issues, c.ref(ids[i]))
		}
		out = append(out, ch)
	}
	if out == nil {
		out = []Chain{}
	}
	return out
}

// statusAt returns an issue's status at t, rebuilt backwards from its current
// status through the status changes after t; "" when it did not exist yet.
func statusAt(is *Issue, changes []StatusChange, t time.Time) string {
	if is.CreatedAt.After(t) {
		return ""
	}
	for _, ch := range changes { // ascending
		if ch.At.After(t) {
			return ch.From
		}
	}
	return is.Status
}

func (c *computer) burndown(openNow int) ([]BurnPoint, ETA) {
	in := c.in
	byIssue := map[string][]StatusChange{}
	for _, ch := range in.Changes {
		if c.scope[ch.IssueID] && c.leaf(ch.IssueID) {
			byIssue[ch.IssueID] = append(byIssue[ch.IssueID], ch)
		}
	}
	for k := range byIssue {
		sort.Slice(byIssue[k], func(i, j int) bool { return byIssue[k][i].At.Before(byIssue[k][j].At) })
	}
	var leaves []*Issue
	for id := range c.scope {
		if c.leaf(id) {
			leaves = append(leaves, c.byID[id])
		}
	}
	at := func(t time.Time) (open, done int) {
		for _, is := range leaves {
			s := statusAt(is, byIssue[is.ID], t)
			if s == "" {
				continue
			}
			switch in.state(s) {
			case stOpen:
				open++
			case stDone:
				done++
			}
		}
		return
	}
	now := in.Now.UTC()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	points := make([]BurnPoint, 0, in.Days+1)
	for i := in.Days; i >= 1; i-- {
		end := day.AddDate(0, 0, -i+1).Add(-time.Nanosecond) // end of that day
		o, d := at(end)
		points = append(points, BurnPoint{Date: end.Format("2006-01-02"), Open: o, Done: d})
	}
	o, d := at(now)
	points = append(points, BurnPoint{Date: now.Format("2006-01-02"), Open: o, Done: d})

	eta := ETA{Open: openNow}
	_, d7 := at(now.Add(-7 * 24 * time.Hour))
	_, d14 := at(now.Add(-14 * 24 * time.Hour))
	eta.Done7, eta.Done14 = max(d-d7, 0), max(d-d14, 0)
	eta.Rate7, eta.Rate14 = round2(float64(eta.Done7)/7), round2(float64(eta.Done14)/14)
	project := func(done int, days float64) (*string, *float64) {
		if done <= 0 {
			return nil, nil
		}
		need := float64(openNow) / (float64(done) / days)
		need = math.Round(need*10) / 10
		s := now.Add(time.Duration(need * float64(24*time.Hour))).Format("2006-01-02")
		return &s, &need
	}
	eta.Date7, eta.Days7 = project(eta.Done7, 7)
	eta.Date14, eta.Days14 = project(eta.Done14, 14)
	return points, eta
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }

func (c *computer) stuck() Stuck {
	s := Stuck{Held: []Ref{}, BlockedNoBlocker: []Ref{}, Idle: []Ref{}}
	var held, bnb, idle []string
	for id := range c.scope {
		is := c.byID[id]
		if c.in.state(is.Status) != stOpen {
			continue
		}
		if is.Status == c.in.HeldStatus {
			held = append(held, id)
		}
		if c.blockedNoBlocker(id) {
			bnb = append(bnb, id)
		}
		if c.idle(id) {
			idle = append(idle, id)
		}
	}
	for _, p := range []struct {
		ids []string
		dst *[]Ref
	}{{held, &s.Held}, {bnb, &s.BlockedNoBlocker}, {idle, &s.Idle}} {
		c.sortRefs(p.ids)
		for _, id := range p.ids {
			*p.dst = append(*p.dst, c.ref(id))
		}
	}
	return s
}

var (
	memberMention = regexp.MustCompile(`mention://member/([0-9a-fA-F-]{36})`)
	markdownLink  = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
)

// recipient: whom an ask is for. The last member it @mentions, else the card's
// Responsible human, else the parent's, else its member creator. The smart
// inbox's own routing (tech owners) wins when a signal exists for the ask.
func (c *computer) recipient(is *Issue, content string) string {
	ok := func(u string) bool { return u != "" && (c.in.Members == nil || c.in.Members[u]) }
	ms := memberMention.FindAllStringSubmatch(content, -1)
	for i := len(ms) - 1; i >= 0; i-- {
		if u := strings.ToLower(ms[i][1]); ok(u) {
			return u
		}
	}
	if ok(is.Responsible) {
		return is.Responsible
	}
	if p := c.byID[is.ParentID]; p != nil && ok(p.Responsible) {
		return p.Responsible
	}
	if ok(is.CreatorMember) {
		return is.CreatorMember
	}
	return ""
}

// Excerpt: the ask's headline, markers and markdown emphasis dropped.
func Excerpt(content string) string {
	s := strings.TrimSpace(content)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	s = markdownLink.ReplaceAllString(s, "$1")
	s = strings.ReplaceAll(s, "**", "")
	for _, m := range []string{"[NEEDS HUMAN]", "[NEEDS OPERATOR]"} {
		s = strings.Replace(s, m, "", 1)
	}
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 200 {
		s = string(r[:199]) + "…"
	}
	return s
}

func (c *computer) humanAsk(a Ask, sig *Signal) HumanAsk {
	is := c.byID[a.IssueID]
	h := HumanAsk{Issue: c.ref(a.IssueID), CommentID: a.CommentID, Kind: a.Kind, Excerpt: Excerpt(a.Content),
		CreatedAt: a.CreatedAt.UTC().Format(time.RFC3339), RecipientID: c.recipient(is, a.Content),
		Blocks: c.dependents[a.IssueID], Replies: []SignalReply{}}
	if sig != nil {
		h.InboxItemID = sig.InboxItemID
		if sig.RecipientID != "" {
			h.RecipientID = sig.RecipientID
		}
		if sig.Replies != nil {
			h.Replies = sig.Replies
		}
	}
	return h
}

func (c *computer) asks() ([]HumanGroup, []HumanAsk) {
	sigs := map[string]*Signal{}
	for i := range c.in.Signals {
		sigs[c.in.Signals[i].CommentID] = &c.in.Signals[i]
	}
	pillar := func(id string) bool {
		p := c.byID[id].ParentID
		return c.scope[id] && (p == "" || !c.scope[p]) && !c.leaf(id)
	}
	groups := map[string]*HumanGroup{}
	blockedBy := map[string]map[string]bool{}
	questions := []HumanAsk{}
	for _, a := range c.in.Asks {
		is := c.byID[a.IssueID]
		if is == nil || a.Answered || c.in.state(is.Status) != stOpen {
			continue
		}
		if a.IssueID == c.in.HomeIssueID || pillar(a.IssueID) {
			questions = append(questions, c.humanAsk(a, sigs[a.CommentID]))
		}
		if a.Kind != "human" || !is.NeedsHuman || !c.scope[a.IssueID] {
			continue
		}
		h := c.humanAsk(a, sigs[a.CommentID])
		g := groups[h.RecipientID]
		if g == nil {
			g = &HumanGroup{RecipientID: h.RecipientID}
			groups[h.RecipientID] = g
			blockedBy[h.RecipientID] = map[string]bool{}
		}
		g.Asks = append(g.Asks, h)
		blockedBy[h.RecipientID][a.IssueID] = true
		for d := range c.downstream([]string{a.IssueID}) {
			blockedBy[h.RecipientID][d] = true
		}
	}
	out := make([]HumanGroup, 0, len(groups))
	for k, g := range groups {
		g.CardsBlocked = len(blockedBy[k])
		sort.Slice(g.Asks, func(i, j int) bool {
			if g.Asks[i].Blocks != g.Asks[j].Blocks {
				return g.Asks[i].Blocks > g.Asks[j].Blocks
			}
			return g.Asks[i].CreatedAt < g.Asks[j].CreatedAt
		})
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CardsBlocked != out[j].CardsBlocked {
			return out[i].CardsBlocked > out[j].CardsBlocked
		}
		return out[i].RecipientID < out[j].RecipientID
	})
	sort.Slice(questions, func(i, j int) bool { return questions[i].CreatedAt > questions[j].CreatedAt })
	return out, questions
}
