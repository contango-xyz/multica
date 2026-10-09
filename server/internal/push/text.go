package push

import "strings"

// inboxInfo is what an inbox push is built from. identifier and actor are
// resolved on the worker and may be empty when the lookup fails.
type inboxInfo struct {
	typ        string
	identifier string // e.g. "MUL-823"
	actor      string
	title      string // the issue title for issue items
	body       string
	to         string // details.to for *_changed items
}

// Labels match the web inbox ("types" in locales/en/inbox.json) for types
// not phrased with an actor or a field change.
var inboxTypeLabels = map[string]string{
	"issue_subscribed":         "Subscribed",
	"assignee_changed":         "Assignee changed",
	"task_completed":           "Run completed",
	"task_failed":              "Run failed",
	"quick_create_done":        "Created with agent",
	"quick_create_failed":      "Create with agent failed",
	"quick_create_unconfirmed": "Create with agent unconfirmed",
	"autopilot_paused":         "Autopilot paused",
	"children_done":            "Sub-issues finished",
	"autopilot_quota_exceeded": "Autopilot run limit reached",
}

// Types phrased "<actor> <verb>" when the actor is known.
var inboxActorVerbs = map[string]struct{ verb, fallback string }{
	"new_comment":      {"commented", "New comment"},
	"mentioned":        {"mentioned you", "Mentioned"},
	"issue_assigned":   {"assigned you", "Assigned to you"},
	"unassigned":       {"unassigned you", "Unassigned"},
	"review_requested": {"requested review", "Review requested"},
	"reaction_added":   {"reacted", "Reacted"},
	"agent_blocked":    {"is blocked", "Agent blocked"},
	"agent_completed":  {"finished", "Agent completed"},
}

var inboxChangeFields = map[string]string{
	"status_changed":     "Status",
	"priority_changed":   "Priority",
	"start_date_changed": "Start date",
	"due_date_changed":   "Due date",
}

// inboxText lays a push out as "<ID> · <what happened>" / issue title /
// detail, so the lock screen shows which ticket and why at a glance.
func inboxText(in inboxInfo) (title, subtitle, body string) {
	what := ""
	body = in.body
	if v, ok := inboxActorVerbs[in.typ]; ok {
		what = v.fallback
		if in.actor != "" {
			what = in.actor + " " + v.verb
		}
	} else if field, ok := inboxChangeFields[in.typ]; ok {
		what = field + " changed"
		if in.to != "" {
			what = field + " → " + humanize(in.to)
		}
		if body == "" && in.actor != "" {
			body = "by " + in.actor
		}
	} else if label, ok := inboxTypeLabels[in.typ]; ok {
		what = label
	} else {
		what = humanize(in.typ)
	}
	if in.identifier == "" {
		return what, in.title, body
	}
	return in.identifier + " · " + what, in.title, body
}

// humanize turns "in_review" into "In review".
func humanize(s string) string {
	s = strings.ReplaceAll(s, "_", " ")
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
