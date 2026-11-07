package service

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestValidJobName(t *testing.T) {
	for _, ok := range []string{"explore", "pr-watch", "0", "a" + strings.Repeat("b", 63)} {
		if !ValidJobName(ok) {
			t.Errorf("ValidJobName(%q) = false", ok)
		}
	}
	for _, bad := range []string{"", "-x", "PR", "a_b", "a b", "a" + strings.Repeat("b", 64)} {
		if ValidJobName(bad) {
			t.Errorf("ValidJobName(%q) = true", bad)
		}
	}
}

func TestTruncateJobOutputTail(t *testing.T) {
	if got := TruncateJobOutputTail("short"); got != "short" {
		t.Fatalf("short: %q", got)
	}
	s := strings.Repeat("é", 5000) + "END" // 10003 bytes
	got := TruncateJobOutputTail(s)
	if len(got) > AutopilotJobOutputTailMax || !strings.HasSuffix(got, "END") || !utf8.ValidString(got) {
		t.Fatalf("tail: len=%d valid=%v", len(got), utf8.ValidString(got))
	}
	if got := TruncateJobOutputTail("a\x00b\xffc"); got != "ab\uFFFDc" {
		t.Fatalf("sanitize: %q", got)
	}
}
