package push

import "testing"

func TestInboxText(t *testing.T) {
	cases := []struct {
		name                  string
		in                    inboxInfo
		title, subtitle, body string
	}{
		{"comment", inboxInfo{typ: "new_comment", identifier: "MUL-823", actor: "Lenny", title: "Fix login", body: "Looks good"},
			"MUL-823 · Lenny commented", "Fix login", "Looks good"},
		{"mention", inboxInfo{typ: "mentioned", identifier: "MUL-1", actor: "Ana", title: "T"},
			"MUL-1 · Ana mentioned you", "T", ""},
		{"assigned", inboxInfo{typ: "issue_assigned", identifier: "MUL-1", actor: "Ana", title: "T"},
			"MUL-1 · Ana assigned you", "T", ""},
		{"assigned without actor", inboxInfo{typ: "issue_assigned", identifier: "MUL-1", title: "T"},
			"MUL-1 · Assigned to you", "T", ""},
		{"status", inboxInfo{typ: "status_changed", identifier: "MUL-1", actor: "Ana", title: "T", to: "in_review"},
			"MUL-1 · Status → In review", "T", "by Ana"},
		{"status keeps body", inboxInfo{typ: "status_changed", identifier: "MUL-1", actor: "Ana", title: "T", to: "done", body: "x"},
			"MUL-1 · Status → Done", "T", "x"},
		{"priority", inboxInfo{typ: "priority_changed", identifier: "MUL-1", title: "T", to: "urgent"},
			"MUL-1 · Priority → Urgent", "T", ""},
		{"unknown type", inboxInfo{typ: "children_done", identifier: "MUL-1", title: "T"},
			"MUL-1 · Sub-issues finished", "T", ""},
		{"never seen type", inboxInfo{typ: "brand_new_thing", identifier: "MUL-1", title: "T"},
			"MUL-1 · Brand new thing", "T", ""},
		{"no issue", inboxInfo{typ: "autopilot_paused", title: "Nightly sweep", body: "b"},
			"Autopilot paused", "Nightly sweep", "b"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			title, subtitle, body := inboxText(c.in)
			if title != c.title || subtitle != c.subtitle || body != c.body {
				t.Fatalf("got (%q, %q, %q), want (%q, %q, %q)", title, subtitle, body, c.title, c.subtitle, c.body)
			}
		})
	}
}
