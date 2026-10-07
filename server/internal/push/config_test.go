package push

import (
	"os"
	"path/filepath"
	"testing"
)

func clearAPNsEnv(t *testing.T) {
	for _, k := range []string{"MULTICA_APNS_KEY", "MULTICA_APNS_KEY_PATH", "MULTICA_APNS_KEY_ID", "MULTICA_APNS_TEAM_ID"} {
		t.Setenv(k, "")
	}
}

func TestConfigFromEnvUnsetIsDisabled(t *testing.T) {
	clearAPNsEnv(t)
	_, ok, err := ConfigFromEnv()
	if ok || err != nil {
		t.Fatalf("ok=%v err=%v, want disabled without error", ok, err)
	}
}

func TestConfigFromEnvPartialIsError(t *testing.T) {
	clearAPNsEnv(t)
	t.Setenv("MULTICA_APNS_KEY_ID", "KEY123")
	if _, _, err := ConfigFromEnv(); err == nil {
		t.Fatal("want error for partial config")
	}
}

func TestConfigFromEnvReadsKeyFile(t *testing.T) {
	clearAPNsEnv(t)
	path := filepath.Join(t.TempDir(), "AuthKey.p8")
	if err := os.WriteFile(path, []byte("PEM"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_APNS_KEY_PATH", path)
	t.Setenv("MULTICA_APNS_KEY_ID", "KEY123")
	t.Setenv("MULTICA_APNS_TEAM_ID", "TEAM123")
	cfg, ok, err := ConfigFromEnv()
	if err != nil || !ok || string(cfg.KeyPEM) != "PEM" || cfg.KeyID != "KEY123" || cfg.TeamID != "TEAM123" {
		t.Fatalf("cfg=%+v ok=%v err=%v", cfg, ok, err)
	}
}

func TestBundleAllowed(t *testing.T) {
	t.Setenv("MULTICA_APNS_ALLOWED_BUNDLE_IDS", "")
	if !BundleAllowed("x") {
		t.Fatal("empty list allows all")
	}
	t.Setenv("MULTICA_APNS_ALLOWED_BUNDLE_IDS", "a.b, c.d")
	if !BundleAllowed("c.d") || BundleAllowed("e.f") {
		t.Fatal("list membership")
	}
}
