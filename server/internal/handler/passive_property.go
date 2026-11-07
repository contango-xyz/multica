package handler

// Passive issue properties (contango patch 23, docs/contango/PATCHES.md).
//
// Property names on MULTICA_PASSIVE_PROPERTIES (comma-separated,
// case-insensitive, matched by name in each workspace) never count as issue
// activity: setting or unsetting one of their values leaves issue.updated_at
// and issue.last_activity_at untouched. The ops box writes a "Waiting on"
// property on every in-flight card, and stall checks read those columns.
// The value change itself is stored, bumps revision and is still published
// on the websocket like any other property change. Empty means no change.

import (
	"os"
	"strings"
)

// ParsePassiveProperties splits MULTICA_PASSIVE_PROPERTIES (comma-separated)
// into a lowercase name set. Empty means no property is passive.
func ParsePassiveProperties(raw string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		if n := strings.ToLower(strings.TrimSpace(part)); n != "" {
			out[n] = true
		}
	}
	return out
}

func passivePropertiesFromEnv() map[string]bool {
	return ParsePassiveProperties(os.Getenv("MULTICA_PASSIVE_PROPERTIES"))
}

// isPassiveProperty reports whether writes to the property named name must not
// bump the issue's activity timestamps.
func (h *Handler) isPassiveProperty(name string) bool {
	return h.PassiveProperties[strings.ToLower(strings.TrimSpace(name))]
}
