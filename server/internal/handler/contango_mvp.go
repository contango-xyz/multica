package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/mvp"
)

// MVP page (contango, patch 19): GET /api/mvp computes what MVP means (the home
// card's description), how far along it is, the critical path(s) and what is in
// the way, from the workspace's issues, dependencies, status history and asks.
// Read-only; any workspace member or agent may call it.

// mvpConfig is read from the environment on each request, so a recreated
// container picks up changes. Names match case-insensitively.
type mvpConfig struct {
	HomeIssue           string // e.g. CTG-2386 or 2386; "" = no definition card
	ReleaseProperty     string
	ReleaseOption       string
	ResponsibleProperty string
	NeedsHumanProperty  string
	HeldStatus          string
	BlockedStatus       string
	IdleHours           int
	Days                int
}

func envOr(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

func envIntOr(name string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && n > 0 {
		return n
	}
	return def
}

func loadMVPConfig() mvpConfig {
	return mvpConfig{
		HomeIssue:           envOr("MULTICA_MVP_HOME_ISSUE", ""),
		ReleaseProperty:     envOr("MULTICA_MVP_RELEASE_PROPERTY", "Release"),
		ReleaseOption:       envOr("MULTICA_MVP_RELEASE_OPTION", "MVP"),
		ResponsibleProperty: envOr("MULTICA_MVP_RESPONSIBLE_PROPERTY", "Responsible human"),
		NeedsHumanProperty:  envOr("MULTICA_MVP_NEEDS_HUMAN_PROPERTY", "Needs human"),
		HeldStatus:          envOr("MULTICA_MVP_HELD_STATUS", "held"),
		BlockedStatus:       envOr("MULTICA_MVP_BLOCKED_STATUS", "blocked"),
		IdleHours:           envIntOr("MULTICA_MVP_IDLE_HOURS", 24),
		Days:                min(envIntOr("MULTICA_MVP_BURNDOWN_DAYS", 30), 180),
	}
}

// issueNumberFromKey parses "CTG-2386" or "2386".
func issueNumberFromKey(key string) (int32, bool) {
	key = strings.TrimSpace(key)
	if i := strings.LastIndexByte(key, '-'); i >= 0 {
		key = key[i+1:]
	}
	n, err := strconv.ParseInt(key, 10, 32)
	return int32(n), err == nil && n > 0
}

type MVPHome struct {
	ID          string `json:"id"`
	Identifier  string `json:"identifier"`
	Title       string `json:"title"`
	Status      string `json:"status"`
	Description string `json:"description"`
}

type MVPConfigView struct {
	HomeIssue       string `json:"home_issue"`
	ReleaseProperty string `json:"release_property"`
	ReleaseOption   string `json:"release_option"`
	IdleHours       int    `json:"idle_hours"`
	Days            int    `json:"days"`
}

type MVPResponse struct {
	// Configured is false when the workspace has no select property/option
	// matching the configuration; Problem then says which is missing.
	Configured  bool          `json:"configured"`
	Problem     string        `json:"problem,omitempty"`
	Config      MVPConfigView `json:"config"`
	GeneratedAt string        `json:"generated_at"`
	Home        *MVPHome      `json:"home"`
	mvp.Report
}

type mvpProperties struct {
	releaseID, optionID, responsibleID, needsHumanID string
}

func (h *Handler) loadMVPProperties(ctx context.Context, ws pgtype.UUID, cfg mvpConfig) (mvpProperties, string, error) {
	var p mvpProperties
	rows, err := h.DB.Query(ctx, `
		SELECT id::text, name, type, config
		FROM issue_property
		WHERE workspace_id = $1 AND archived_at IS NULL
		ORDER BY created_at`, ws)
	if err != nil {
		return p, "", err
	}
	defer rows.Close()
	releaseFound := false
	for rows.Next() {
		var id, name, typ string
		var config []byte
		if err := rows.Scan(&id, &name, &typ, &config); err != nil {
			return p, "", err
		}
		switch {
		case strings.EqualFold(name, cfg.ReleaseProperty) && (typ == "select") && !releaseFound:
			releaseFound = true
			p.releaseID = id
			var c struct {
				Options []struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"options"`
			}
			_ = json.Unmarshal(config, &c)
			for _, o := range c.Options {
				if strings.EqualFold(o.Name, cfg.ReleaseOption) {
					p.optionID = o.ID
					break
				}
			}
		case strings.EqualFold(name, cfg.ResponsibleProperty) && p.responsibleID == "":
			p.responsibleID = id
		case strings.EqualFold(name, cfg.NeedsHumanProperty) && p.needsHumanID == "":
			p.needsHumanID = id
		}
	}
	if err := rows.Err(); err != nil {
		return p, "", err
	}
	if !releaseFound {
		return p, fmt.Sprintf("no select property named %q", cfg.ReleaseProperty), nil
	}
	if p.optionID == "" {
		return p, fmt.Sprintf("property %q has no option named %q", cfg.ReleaseProperty, cfg.ReleaseOption), nil
	}
	return p, "", nil
}

func botMemberIDs() []string {
	var out []string
	for _, raw := range strings.Split(os.Getenv(botMemberIDsEnv), ",") {
		if s := strings.ToLower(strings.TrimSpace(raw)); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// GetMVP serves GET /api/mvp.
func (h *Handler) GetMVP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ws, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}
	resp, err := h.computeMVP(ctx, ws, loadMVPConfig(), time.Now())
	if err != nil {
		slog.Warn("GetMVP failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to compute the MVP page")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) computeMVP(ctx context.Context, ws pgtype.UUID, cfg mvpConfig, now time.Time) (*MVPResponse, error) {
	prefix := h.getIssuePrefix(ctx, ws)
	resp := &MVPResponse{
		Config: MVPConfigView{HomeIssue: cfg.HomeIssue, ReleaseProperty: cfg.ReleaseProperty,
			ReleaseOption: cfg.ReleaseOption, IdleHours: cfg.IdleHours, Days: cfg.Days},
		GeneratedAt: now.UTC().Format(time.RFC3339),
	}
	resp.Report = mvp.Report{Pillars: []mvp.Pillar{}, CriticalPaths: []mvp.Chain{}, Burndown: []mvp.BurnPoint{},
		Humans: []mvp.HumanGroup{}, AgentQuestions: []mvp.HumanAsk{},
		Stuck:      mvp.Stuck{Held: []mvp.Ref{}, BlockedNoBlocker: []mvp.Ref{}, Idle: []mvp.Ref{}},
		Totals:     mvp.Counts{ByStatus: map[string]int{}},
		Standalone: mvp.Group{Counts: mvp.Counts{ByStatus: map[string]int{}}, OpenItems: []mvp.Ref{}}}

	if n, ok := issueNumberFromKey(cfg.HomeIssue); ok {
		var home MVPHome
		var number int32
		err := h.DB.QueryRow(ctx, `
			SELECT id::text, number, title, status, COALESCE(description, '')
			FROM issue WHERE workspace_id = $1 AND number = $2`, ws, n).
			Scan(&home.ID, &number, &home.Title, &home.Status, &home.Description)
		if err == nil {
			home.Identifier = dependencyIdentifier(prefix, number)
			resp.Home = &home
		}
	}

	props, problem, err := h.loadMVPProperties(ctx, ws, cfg)
	if err != nil {
		return nil, fmt.Errorf("properties: %w", err)
	}
	if problem != "" {
		resp.Problem = problem
		return resp, nil
	}
	resp.Configured = true

	in := mvp.Input{Now: now, Categories: map[string]string{}, Members: map[string]bool{},
		HeldStatus: cfg.HeldStatus, BlockedState: cfg.BlockedStatus,
		IdleAfter: time.Duration(cfg.IdleHours) * time.Hour, Days: cfg.Days}
	if resp.Home != nil {
		in.HomeIssueID = resp.Home.ID
	}

	// Status catalog, archived keys included: history may name them.
	srows, err := h.DB.Query(ctx, `SELECT key, category FROM issue_status WHERE workspace_id = $1`, ws)
	if err != nil {
		return nil, fmt.Errorf("statuses: %w", err)
	}
	for srows.Next() {
		var k, c string
		if err := srows.Scan(&k, &c); err != nil {
			srows.Close()
			return nil, err
		}
		in.Categories[k] = c
	}
	srows.Close()

	bots := botMemberIDs()
	mrows, err := h.DB.Query(ctx, `SELECT user_id::text FROM member WHERE workspace_id = $1`, ws)
	if err != nil {
		return nil, fmt.Errorf("members: %w", err)
	}
	for mrows.Next() {
		var u string
		if err := mrows.Scan(&u); err != nil {
			mrows.Close()
			return nil, err
		}
		in.Members[strings.ToLower(u)] = true
	}
	mrows.Close()
	for _, b := range bots {
		delete(in.Members, b)
	}

	// Every issue of the workspace: scope needs the parent chains.
	irows, err := h.DB.Query(ctx, `
		SELECT i.id::text, COALESCE(i.parent_issue_id::text, ''), i.number, i.title, i.status, i.priority,
		       COALESCE(i.assignee_type, ''), COALESCE(i.assignee_id::text, ''),
		       CASE WHEN i.creator_type = 'member' THEN i.creator_id::text ELSE '' END,
		       i.created_at,
		       COALESCE(i.properties ->> $2::text, ''),
		       COALESCE(i.properties ->> $3::text, ''),
		       COALESCE(i.properties ->> $4::text, '')
		FROM issue i
		WHERE i.workspace_id = $1`, ws, props.releaseID, props.responsibleID, props.needsHumanID)
	if err != nil {
		return nil, fmt.Errorf("issues: %w", err)
	}
	for irows.Next() {
		var is mvp.Issue
		var release, responsible, needsHuman string
		if err := irows.Scan(&is.ID, &is.ParentID, &is.Number, &is.Title, &is.Status, &is.Priority,
			&is.AssigneeType, &is.AssigneeID, &is.CreatorMember, &is.CreatedAt, &release, &responsible, &needsHuman); err != nil {
			irows.Close()
			return nil, err
		}
		is.Identifier = dependencyIdentifier(prefix, is.Number)
		switch release {
		case "":
			is.Release = mvp.ReleaseNone
		case props.optionID:
			is.Release = mvp.ReleaseMVP
		default:
			is.Release = mvp.ReleaseOther
		}
		if u, ok := strings.CutPrefix(responsible, "member:"); ok {
			is.Responsible = strings.ToLower(u)
		}
		is.NeedsHuman = needsHuman == "true"
		in.Issues = append(in.Issues, is)
	}
	irows.Close()
	if err := irows.Err(); err != nil {
		return nil, err
	}

	scope := mvp.Scope(in.Issues, in.HomeIssueID)
	byID := make(map[string]*mvp.Issue, len(in.Issues))
	for i := range in.Issues {
		byID[in.Issues[i].ID] = &in.Issues[i]
	}
	closed := func(status string) bool {
		c := in.Categories[status]
		return c == "done" || c == "closed" || (c == "" && (status == "done" || status == "cancelled"))
	}
	var scopeOpen, askIssues []string
	for id := range scope {
		is := byID[id]
		if closed(is.Status) {
			continue
		}
		scopeOpen = append(scopeOpen, id)
		if p := is.ParentID; is.NeedsHuman || p == "" || !scope[p] { // flagged cards and pillars
			askIssues = append(askIssues, id)
		}
	}
	if in.HomeIssueID != "" {
		askIssues = append(askIssues, in.HomeIssueID)
	}

	edges, err := h.Queries.ListWorkspaceDependencyEdges(ctx, ws)
	if err != nil {
		return nil, fmt.Errorf("edges: %w", err)
	}
	for _, e := range edges {
		in.Edges = append(in.Edges, mvp.Edge{Blocked: uuidToString(e.IssueID), Blocker: uuidToString(e.DependsOnIssueID)})
	}

	// Newest agent run per open MVP card; an active run counts as now.
	if len(scopeOpen) > 0 {
		trows, err := h.DB.Query(ctx, `
			SELECT t.issue_id::text,
			       max(CASE WHEN t.status IN ('queued', 'dispatched', 'running', 'waiting_local_directory') THEN now()
			                ELSE COALESCE(t.completed_at, t.started_at, t.created_at) END)
			FROM agent_task_queue t
			WHERE t.issue_id = ANY($1::uuid[])
			GROUP BY t.issue_id`, scopeOpen)
		if err != nil {
			return nil, fmt.Errorf("runs: %w", err)
		}
		for trows.Next() {
			var id string
			var at time.Time
			if err := trows.Scan(&id, &at); err != nil {
				trows.Close()
				return nil, err
			}
			if is := byID[id]; is != nil {
				is.LastRunAt = &at
			}
		}
		trows.Close()
	}

	// Status history inside the burndown window (plus the ETA's 14 days).
	since := now.AddDate(0, 0, -max(cfg.Days, 14)-1)
	crows, err := h.DB.Query(ctx, `
		SELECT issue_id::text, created_at, COALESCE(details ->> 'from', ''), COALESCE(details ->> 'to', '')
		FROM activity_log
		WHERE workspace_id = $1 AND action = 'status_changed' AND created_at >= $2 AND issue_id IS NOT NULL
		ORDER BY created_at`, ws, since)
	if err != nil {
		return nil, fmt.Errorf("history: %w", err)
	}
	for crows.Next() {
		var ch mvp.StatusChange
		if err := crows.Scan(&ch.IssueID, &ch.At, &ch.From, &ch.To); err != nil {
			crows.Close()
			return nil, err
		}
		if scope[ch.IssueID] && ch.From != "" {
			in.Changes = append(in.Changes, ch)
		}
	}
	crows.Close()

	if len(askIssues) > 0 {
		// The latest ask of each kind per card. Answered: a person (not a bot
		// member, not a pr-watch prompt) commented since, or, for an operator
		// ask, an "Operator note" reply.
		arows, err := h.DB.Query(ctx, `
			SELECT DISTINCT ON (c.issue_id, k.kind)
			       c.issue_id::text, c.id::text, k.kind, c.content, c.created_at,
			       EXISTS (
			         SELECT 1 FROM comment a
			         WHERE a.issue_id = c.issue_id AND a.deleted_at IS NULL AND a.created_at > c.created_at
			           AND ((a.author_type = 'member' AND NOT (a.author_id::text = ANY($2::text[]))
			                 AND a.content NOT LIKE '%PR_WATCH:%')
			                OR (k.kind = 'operator' AND a.content LIKE '%Operator note%'))
			       ) AS answered
			FROM comment c
			CROSS JOIN LATERAL (
			  SELECT CASE WHEN c.content ~ '^\s*(\*\*)?\[NEEDS HUMAN\]' THEN 'human' ELSE 'operator' END AS kind
			) k
			WHERE c.issue_id = ANY($1::uuid[]) AND c.deleted_at IS NULL
			  AND c.content ~ '^\s*(\*\*)?\[NEEDS (HUMAN|OPERATOR)\]'
			ORDER BY c.issue_id, k.kind, c.created_at DESC`, askIssues, append([]string{}, bots...))
		if err != nil {
			return nil, fmt.Errorf("asks: %w", err)
		}
		for arows.Next() {
			var a mvp.Ask
			if err := arows.Scan(&a.IssueID, &a.CommentID, &a.Kind, &a.Content, &a.CreatedAt, &a.Answered); err != nil {
				arows.Close()
				return nil, err
			}
			in.Asks = append(in.Asks, a)
		}
		arows.Close()

		// Smart-inbox entries for those asks (patch 14): the feeder's routing and
		// one-tap replies (patch 18). Key: needs-human:<KEY>:<ask comment id>.
		grows, err := h.DB.Query(ctx, `
			SELECT x.id::text, x.recipient_id::text, x.issue_id::text, x.details ->> 'key',
			       COALESCE(x.details -> 'replies', '[]'::jsonb)
			FROM inbox_item x
			WHERE x.workspace_id = $1 AND x.type = 'signal' AND NOT x.archived
			  AND x.details ->> 'resolved_at' IS NULL AND x.details ->> 'key' LIKE 'needs-human:%'
			  AND x.issue_id = ANY($2::uuid[])`, ws, askIssues)
		if err != nil {
			return nil, fmt.Errorf("signals: %w", err)
		}
		for grows.Next() {
			var s mvp.Signal
			var key string
			var replies []byte
			if err := grows.Scan(&s.InboxItemID, &s.RecipientID, &s.IssueID, &key, &replies); err != nil {
				grows.Close()
				return nil, err
			}
			s.CommentID = key[strings.LastIndexByte(key, ':')+1:]
			_ = json.Unmarshal(replies, &s.Replies)
			for i := range s.Replies {
				s.Replies[i].Index = i
			}
			in.Signals = append(in.Signals, s)
		}
		grows.Close()
	}

	resp.Report = mvp.Compute(in)
	return resp, nil
}
