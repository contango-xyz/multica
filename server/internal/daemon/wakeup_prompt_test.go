package daemon

import (
	"strings"
	"testing"
)

func TestWakeupPromptPreservesInstructionAndDeliveryThread(t *testing.T) {
	p := BuildPrompt(Task{IssueID: "issue", WakeupID: "wake", TriggerCommentID: "original", TriggerCommentContent: "old instruction", HandoffNote: "task.completed run-x; check its result"}, "codex")
	for _, want := range []string{"[WAKEUP]", "check its result", "--parent original", "wakeup disable issue wake", "--roots-only"} {
		if !strings.Contains(p, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(p, "[NEW COMMENT]") || strings.Contains(p, "old instruction") {
		t.Fatal("replayed the old comment instead of the wakeup")
	}
}

func TestHiddenWakeupPromptDoesNotPointAtItsRule(t *testing.T) {
	p := BuildPrompt(Task{IssueID: "issue", WakeupID: "wake", WakeupHidden: true, HandoffNote: "go now"}, "codex")
	if !strings.Contains(p, "[WAKEUP]\ngo now") || strings.Contains(p, "multica issue wakeup get") {
		t.Fatalf("prompt = %s", p)
	}
}
