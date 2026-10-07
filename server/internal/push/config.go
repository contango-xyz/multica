// Package push delivers native push notifications (APNs) for inbox items and
// chat replies. It is inert unless APNs credentials are configured.
package push

import (
	"os"
	"strings"
)

// BundleAllowed reports whether devices of this app bundle may register.
// MULTICA_APNS_ALLOWED_BUNDLE_IDS is a comma list; empty allows any bundle.
func BundleAllowed(bundleID string) bool {
	raw := strings.TrimSpace(os.Getenv("MULTICA_APNS_ALLOWED_BUNDLE_IDS"))
	if raw == "" {
		return true
	}
	for _, id := range strings.Split(raw, ",") {
		if strings.TrimSpace(id) == bundleID {
			return true
		}
	}
	return false
}
