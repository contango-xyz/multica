// Package push delivers native push notifications (APNs) for inbox items and
// chat replies. It is inert unless APNs credentials are configured.
package push

import (
	"errors"
	"fmt"
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

// Config holds APNs token-auth credentials.
type Config struct {
	KeyPEM []byte
	KeyID  string
	TeamID string
}

// ConfigFromEnv reads APNs credentials. Nothing set → (zero, false, nil):
// push stays off. Partially set or unreadable key → error.
func ConfigFromEnv() (Config, bool, error) {
	keyID := strings.TrimSpace(os.Getenv("MULTICA_APNS_KEY_ID"))
	teamID := strings.TrimSpace(os.Getenv("MULTICA_APNS_TEAM_ID"))
	keyInline := os.Getenv("MULTICA_APNS_KEY")
	keyPath := strings.TrimSpace(os.Getenv("MULTICA_APNS_KEY_PATH"))
	if keyID == "" && teamID == "" && strings.TrimSpace(keyInline) == "" && keyPath == "" {
		return Config{}, false, nil
	}
	var key []byte
	switch {
	case strings.TrimSpace(keyInline) != "":
		key = []byte(keyInline)
	case keyPath != "":
		b, err := os.ReadFile(keyPath)
		if err != nil {
			return Config{}, false, fmt.Errorf("read MULTICA_APNS_KEY_PATH: %w", err)
		}
		key = b
	}
	if len(key) == 0 || keyID == "" || teamID == "" {
		return Config{}, false, errors.New("APNs config incomplete: need key (MULTICA_APNS_KEY or MULTICA_APNS_KEY_PATH), MULTICA_APNS_KEY_ID and MULTICA_APNS_TEAM_ID")
	}
	return Config{KeyPEM: key, KeyID: keyID, TeamID: teamID}, true, nil
}
