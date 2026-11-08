package service

import (
	"errors"
	"strings"
	"testing"
)

func decisionInput() IssueAskInput {
	return IssueAskInput{
		AddresseeType: AskAddresseeMember, AddresseeID: "6d71b44b-849b-4f63-94b7-6d8056785953", Kind: AskKindDecision,
		Topic:   "Which copy?",
		Options: []IssueAskOption{{Reply: "agree"}, {Label: "Reply", Reply: "changes: <what>"}},
	}
}

func TestRenderAskCommentHumanFormat(t *testing.T) {
	in := decisionInput()
	in.Where, in.WhyAsked, in.Approving, in.Risk, in.Links = "the story", "first ask", "the copy", "low", "[PR](https://x)"
	in.Recommended, in.RecommendReason = "agree", "it reads better"
	in.DefaultOption, in.Reversible = "agree", true
	if err := in.Normalize(); err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"**[NEEDS HUMAN]** Which copy?",
		"**Where we are:** the story",
		"**Why you're asked:** first ask",
		"**Reply with:** `agree` / `changes: <what>`",
		"**I recommend:** `agree`: it reads better",
		"---",
		"**What you are approving:** the copy",
		"**Risk:** low",
		"**Default if no answer:** `agree` (reversible)",
		"**Links:** [PR](https://x)",
		"[@ana](mention://member/6d71b44b-849b-4f63-94b7-6d8056785953)",
	}, "\n\n")
	if got := RenderAskComment(in, "ana"); got != want {
		t.Fatalf("rendered:\n%s\nwant:\n%s", got, want)
	}
}

func TestRenderAskCommentNoDefaultAndMarkers(t *testing.T) {
	in := decisionInput()
	in.Tech = true
	in.DefaultWhy = "touches production"
	if err := in.Normalize(); err != nil {
		t.Fatal(err)
	}
	got := RenderAskComment(in, "ana")
	if !strings.HasPrefix(got, "**[NEEDS HUMAN]** [TECH] Which copy?") {
		t.Fatalf("tech marker: %s", got)
	}
	if !strings.Contains(got, "**Default if no answer:** none (irreversible: touches production)") {
		t.Fatalf("default line: %s", got)
	}

	merge := decisionInput()
	merge.Kind = AskKindMerge
	if err := merge.Normalize(); err != nil {
		t.Fatal(err)
	}
	if got := RenderAskComment(merge, "ana"); !strings.Contains(got, "none (irreversible: merge)") {
		t.Fatalf("merge default line: %s", got)
	}

	pick := decisionInput()
	pick.Kind = AskKindTechOwner
	if err := pick.Normalize(); err != nil {
		t.Fatal(err)
	}
	if got := RenderAskComment(pick, "ana"); !strings.HasPrefix(got, "**[NEEDS HUMAN]** [TECH OWNER] Which copy?") {
		t.Fatalf("tech owner marker: %s", got)
	}
}

func TestRenderAskCommentOperatorFormat(t *testing.T) {
	in := IssueAskInput{AddresseeType: AskAddresseeRole, AddresseeRole: AskRoleOperator, Kind: AskKindOperator,
		Topic: "bot-push evidence", LastLine: "exit 1", Diagnosis: "disk\nfull", Fix: "resize"}
	if err := in.Normalize(); err != nil {
		t.Fatal(err)
	}
	want := "**[NEEDS OPERATOR]** bot-push evidence\n\n**Last line:** exit 1\n\n**Diagnosis:** disk full\n\n**Suggested fix:** resize"
	if got := RenderAskComment(in, ""); got != want {
		t.Fatalf("rendered:\n%s\nwant:\n%s", got, want)
	}
}

func TestAskInputNormalizeRejects(t *testing.T) {
	cases := map[string]func(*IssueAskInput){
		"empty topic":        func(in *IssueAskInput) { in.Topic = "  " },
		"multi-line topic":   func(in *IssueAskInput) { in.Topic = "a\nb" },
		"bad kind":           func(in *IssueAskInput) { in.Kind = "nope" },
		"agent addressee":    func(in *IssueAskInput) { in.AddresseeType = AskAddresseeAgent },
		"no options":         func(in *IssueAskInput) { in.Options = nil },
		"backtick in reply":  func(in *IssueAskInput) { in.Options[0].Reply = "a`b" },
		"duplicate reply":    func(in *IssueAskInput) { in.Options[1].Reply = "agree" },
		"bad recommended":    func(in *IssueAskInput) { in.Recommended = "nope" },
		"default not listed": func(in *IssueAskInput) { in.DefaultOption, in.Reversible = "nope", true },
		"default not reversible": func(in *IssueAskInput) {
			in.DefaultOption = "agree"
		},
		"reversible no default": func(in *IssueAskInput) { in.Reversible = true },
		"default on merge":      func(in *IssueAskInput) { in.Kind, in.DefaultOption, in.Reversible = AskKindMerge, "agree", true },
		"operator kind to member": func(in *IssueAskInput) {
			in.Kind = AskKindOperator
		},
		"role not operator": func(in *IssueAskInput) { in.AddresseeType, in.AddresseeRole = AskAddresseeRole, "admin" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			in := decisionInput()
			mutate(&in)
			err := in.Normalize()
			var bad *AskInputError
			if !errors.As(err, &bad) {
				t.Fatalf("want AskInputError, got %v", err)
			}
		})
	}
}
