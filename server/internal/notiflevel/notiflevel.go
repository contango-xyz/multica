// Package notiflevel decides whether an inbox item pushes to a person's phone or desktop (contango patch 39).
//
// Every inbox item falls in one category (from its type, a smart-inbox signal's group, or the card's labels).
// Each category has a level: Low, Normal, High or Critical. A workspace default comes from Defaults; each
// person can override it ("level_<category>"). Each person also picks the lowest level that may push to their
// phone ("push_min_mobile") and to their desktop ("push_min_desktop"), or "off". Outside the person's working
// hours ("work_hours") only Critical pushes. The in-app inbox is never filtered here: it shows everything, with
// Multica's own filters.
//
// Owner, 2026-11-10: "a merge request is a low, but a tag on a prod issue is a critical … each person assigns the
// level to each, and then they define which level is the min they want to get a notif".
package notiflevel

import (
	"regexp"
	"strings"
	"time"
	_ "time/tzdata" // IANA zones even in a minimal image
)

// Level orders how urgent a notification is.
type Level int

const (
	Off Level = iota // only valid as a minimum: never push
	Low
	Normal
	High
	Critical
)

var levelNames = map[string]Level{"off": Off, "low": Low, "normal": Normal, "high": High, "critical": Critical}

// ParseLevel reads "low", "normal", "high", "critical" (and "off" when allowOff).
func ParseLevel(s string, allowOff bool) (Level, bool) {
	l, ok := levelNames[strings.ToLower(strings.TrimSpace(s))]
	if !ok || (l == Off && !allowOff) {
		return 0, false
	}
	return l, true
}

func (l Level) String() string {
	for k, v := range levelNames {
		if v == l {
			return k
		}
	}
	return "normal"
}

// Category is one user-facing notification category.
type Category struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Default string   `json:"default"`
	Types   []string `json:"types,omitempty"`  // inbox item types in it
	Groups  []string `json:"groups,omitempty"` // smart-inbox signal groups in it
}

// Categories lists every category, lowest default first (the settings page shows them in this order).
var Categories = []Category{
	{Key: "merge_requests", Label: "Merge and approval requests", Default: "low", Groups: []string{"merge"}},
	{Key: "status_changes", Label: "Status changes", Default: "low", Types: []string{"status_changed", "children_done"}},
	{Key: "subscribed", Label: "Activity on cards you follow", Default: "low", Types: []string{"issue_subscribed"}},
	{Key: "comments", Label: "Comments and reactions", Default: "low", Types: []string{"new_comment", "reaction_added"}},
	{Key: "updates", Label: "Priority and date changes", Default: "low", Types: []string{"priority_changed", "start_date_changed", "due_date_changed"}},
	{Key: "agent_activity", Label: "Agent finished a task", Default: "low", Types: []string{"task_completed", "agent_completed", "quick_create_done", "quick_create_failed", "quick_create_unconfirmed"}},
	{Key: "fyi", Label: "For your information", Default: "low", Groups: []string{"fyi"}},
	{Key: "mentions", Label: "Mentions", Default: "normal", Types: []string{"mentioned"}},
	{Key: "assignments", Label: "Cards assigned to you", Default: "normal", Types: []string{"issue_assigned", "unassigned", "assignee_changed"}},
	{Key: "agent_problems", Label: "Agent failed or blocked", Default: "normal", Types: []string{"task_failed", "agent_blocked"}},
	{Key: "stalled", Label: "Stalled work", Default: "normal", Groups: []string{"stalled"}},
	{Key: "automation", Label: "Automation paused or out of quota", Default: "normal", Types: []string{"autopilot_paused", "autopilot_quota_exceeded"}},
	{Key: "review_requested", Label: "Reviews requested from you", Default: "high", Types: []string{"review_requested"}},
	{Key: "asks", Label: "Questions and decisions for you", Default: "high", Groups: []string{"decision", "access"}},
	{Key: "blocking", Label: "You are blocking work", Default: "high", Groups: []string{"blocking"}},
	{Key: "alerts", Label: "Alerts (main or deploys down)", Default: "critical", Groups: []string{"alert"}},
	{Key: "production_security", Label: "Production and security cards", Default: "critical"},
}

// CriticalLabel marks a card whose every notification is Production and security: a "security" label, or a
// production/incident one ("a tag on a prod issue is a critical").
var CriticalLabel = regexp.MustCompile(`(?i)^(security|prod|production|incident)(\b|$|[:/ -])`)

var byType, byGroup = map[string]string{}, map[string]string{}
var defaults = map[string]Level{}

func init() {
	for _, c := range Categories {
		for _, t := range c.Types {
			byType[t] = c.Key
		}
		for _, g := range c.Groups {
			byGroup[g] = c.Key
		}
		l, _ := ParseLevel(c.Default, false)
		defaults[c.Key] = l
	}
}

// CategoryOf: the card's labels first (production/security wins), then a signal's group, then the item type.
// Unknown types are "mentions"-like: Normal, via the "other" key.
func CategoryOf(itemType, signalGroup string, labels []string) string {
	for _, l := range labels {
		if CriticalLabel.MatchString(strings.TrimSpace(l)) {
			return "production_security"
		}
	}
	if itemType == "signal" {
		if k, ok := byGroup[signalGroup]; ok {
			return k
		}
		return "fyi"
	}
	if k, ok := byType[itemType]; ok {
		return k
	}
	return "other"
}

// Preference keys.
func LevelKey(category string) string { return "level_" + category }

const (
	MinMobileKey  = "push_min_mobile"
	MinDesktopKey = "push_min_desktop"
	WorkHoursKey  = "work_hours"
)

// ValidKey reports whether k is one of this package's preference keys, and checks its value.
func ValidKey(k, v string) (known, ok bool) {
	switch {
	case k == MinMobileKey || k == MinDesktopKey:
		_, good := ParseLevel(v, true)
		return true, good
	case strings.HasPrefix(k, "level_"):
		if _, cat := defaults[strings.TrimPrefix(k, "level_")]; !cat {
			return true, false
		}
		_, good := ParseLevel(v, false)
		return true, good
	}
	return false, false
}

// Effective is the category's level for this person: their override, else the default (Normal for "other").
func Effective(prefs map[string]string, category string) Level {
	if l, ok := ParseLevel(prefs[LevelKey(category)], false); ok {
		return l
	}
	if l, ok := defaults[category]; ok {
		return l
	}
	return Normal
}

// Surface is where a push lands.
type Surface string

const (
	Mobile  Surface = "mobile"
	Desktop Surface = "desktop"
)

// SurfaceForPlatform maps a push_device platform to its surface.
func SurfaceForPlatform(platform string) Surface {
	if platform == "macos" {
		return Desktop
	}
	return Mobile
}

// Minimum is the lowest level that pushes to this surface. Default Low: nothing changes until a person sets it.
func Minimum(prefs map[string]string, s Surface) Level {
	key := MinMobileKey
	if s == Desktop {
		key = MinDesktopKey
	}
	if l, ok := ParseLevel(prefs[key], true); ok {
		return l
	}
	return Low
}

// Away answers whether the person is off now, beyond their working hours (time off from the availability
// calendar, patch 38). Nil until something sets it; then it is consulted like working hours.
var Away func(workspaceID, userID string, now time.Time) bool

// Allowed: does an item of this category push to this surface now? Off never pushes; outside working hours or
// while away only Critical does.
func Allowed(prefs map[string]string, category string, s Surface, workspaceID, userID string, now time.Time) bool {
	min := Minimum(prefs, s)
	if min == Off {
		return false
	}
	lvl := Effective(prefs, category)
	if lvl < min {
		return false
	}
	if lvl == Critical {
		return true
	}
	if !InWorkHours(prefs[WorkHoursKey], now) {
		return false
	}
	if Away != nil && Away(workspaceID, userID, now) {
		return false
	}
	return true
}

var dayIndex = map[string]int{"Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6}

// InWorkHours evaluates a "work_hours" value ("<zone>|<days>|<HH:MM-HH:MM>"; hours may cross midnight, the
// window then belongs to the day it starts). Empty or unreadable means always working: no quiet hours.
func InWorkHours(v string, now time.Time) bool {
	parts := strings.Split(v, "|")
	if v == "" || len(parts) != 3 {
		return true
	}
	loc, err := time.LoadLocation(parts[0])
	if err != nil {
		return true
	}
	from, to, ok := strings.Cut(parts[2], "-")
	if !ok {
		return true
	}
	f, err1 := time.Parse("15:04", from)
	t, err2 := time.Parse("15:04", to)
	if err1 != nil || err2 != nil {
		return true
	}
	days := map[int]bool{}
	for _, d := range strings.Split(parts[1], ",") {
		a, b, isRange := strings.Cut(d, "-")
		ai, ok1 := dayIndex[a]
		if !ok1 {
			return true
		}
		if !isRange {
			days[ai] = true
			continue
		}
		bi, ok2 := dayIndex[b]
		if !ok2 {
			return true
		}
		for i := ai; ; i = (i + 1) % 7 {
			days[i] = true
			if i == bi {
				break
			}
		}
	}
	local := now.In(loc)
	mins := local.Hour()*60 + local.Minute()
	fm, tm := f.Hour()*60+f.Minute(), t.Hour()*60+t.Minute()
	day := int(local.Weekday())
	if fm < tm {
		return days[day] && mins >= fm && mins < tm
	}
	// crosses midnight: today's evening part, or yesterday's window continuing
	if mins >= fm {
		return days[day]
	}
	if mins < tm {
		return days[(day+6)%7]
	}
	return false
}
