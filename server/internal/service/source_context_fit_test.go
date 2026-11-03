package service

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func fitComment(id string, parent string, size int) SourceContextCommentSnapshot {
	c := SourceContextCommentSnapshot{ID: id, Type: "comment", Content: strings.Repeat("x", size), Attachments: []SourceContextAttachment{}}
	if parent != "" {
		p := parent
		c.ParentID = &p
	}
	return c
}

func fitSnapshot(desc int, thread ...SourceContextCommentSnapshot) SourceContextSnapshot {
	d := strings.Repeat("d", desc)
	return SourceContextSnapshot{
		SourceIssue:     SourceContextIssueSnapshot{ID: "issue", Identifier: "CTG-860", Description: &d, Attachments: []SourceContextAttachment{}},
		CommentThread:   thread,
		AnchorCommentID: thread[len(thread)-1].ID,
	}
}

const kb = 1 << 10

func ids(thread []SourceContextCommentSnapshot) []string {
	out := make([]string, len(thread))
	for i, c := range thread {
		out[i] = c.ID
	}
	return out
}

func TestReduceSourceContextToFitLeavesSmallThreadsAlone(t *testing.T) {
	in := fitSnapshot(10, fitComment("root", "", 100), fitComment("anchor", "root", 100))
	out, err := ReduceSourceContextToFit(in)
	if err != nil || out.Truncated != nil || !reflect.DeepEqual(out, in) {
		t.Fatalf("out=%+v err=%v", out.Truncated, err)
	}
}

func TestReduceSourceContextToFitDropsOffPathCommentsOldestFirst(t *testing.T) {
	// root -> anchor is the path; a, b (and a's reply a1) are off it.
	in := fitSnapshot(10,
		fitComment("root", "", 100*kb),
		fitComment("a", "root", 400*kb),
		fitComment("a1", "a", 100*kb),
		fitComment("b", "root", 400*kb),
		fitComment("c", "root", 100*kb),
		fitComment("anchor", "root", 50*kb),
	)
	out, err := ReduceSourceContextToFit(in)
	if err != nil {
		t.Fatal(err)
	}
	// The oldest off-path comment goes first, with its reply.
	if got := ids(out.CommentThread); !reflect.DeepEqual(got, []string{"root", "b", "c", "anchor"}) {
		t.Fatalf("thread = %v", got)
	}
	if out.Truncated == nil || !reflect.DeepEqual(out.Truncated.OmittedCommentIDs, []string{"a", "a1"}) || out.Truncated.IssueDescriptionOmitted {
		t.Fatalf("truncated = %+v", out.Truncated)
	}
	if ok, _ := sourceContextFits(out); !ok {
		t.Fatal("reduced snapshot does not fit")
	}
	// Deterministic: the same input reduces the same way, and the input is untouched.
	again, _ := ReduceSourceContextToFit(in)
	if !reflect.DeepEqual(out, again) || len(in.CommentThread) != 6 || in.Truncated != nil {
		t.Fatal("reduction is not deterministic or mutated its input")
	}
}

func TestReduceSourceContextToFitEmptiesPathThenDescription(t *testing.T) {
	// A deep path of long verdicts: root -> r1 -> r2 -> anchor.
	in := fitSnapshot(300*kb,
		fitComment("root", "", 400*kb),
		fitComment("r1", "root", 400*kb),
		fitComment("r2", "r1", 300*kb),
		fitComment("anchor", "r2", 200*kb),
	)
	out, err := ReduceSourceContextToFit(in)
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(out.CommentThread); !reflect.DeepEqual(got, []string{"root", "r1", "r2", "anchor"}) {
		t.Fatalf("the path keeps its shape: %v", got)
	}
	if out.CommentThread[0].Content != "" || out.CommentThread[3].Content != in.CommentThread[3].Content {
		t.Fatalf("oldest path comment should be emptied first and the anchor kept")
	}
	if len(out.Truncated.EmptiedCommentIDs) == 0 || out.Truncated.EmptiedCommentIDs[0] != "root" {
		t.Fatalf("truncated = %+v", out.Truncated)
	}

	// When emptying the path is not enough, the issue description goes too.
	in = fitSnapshot(900*kb, fitComment("root", "", 50*kb), fitComment("anchor", "root", 300*kb))
	out, err = ReduceSourceContextToFit(in)
	if err != nil || !out.Truncated.IssueDescriptionOmitted || out.SourceIssue.Description != nil {
		t.Fatalf("description: %+v err=%v", out.Truncated, err)
	}
}

func TestReduceSourceContextToFitDropsAttachmentsOverTheCount(t *testing.T) {
	old := fitComment("old", "root", 10)
	for i := 0; i < SourceContextMaxAttachments; i++ {
		old.Attachments = append(old.Attachments, SourceContextAttachment{ID: fmt.Sprintf("att-%d", i), SizeBytes: 10})
	}
	anchor := fitComment("anchor", "root", 10)
	anchor.Attachments = []SourceContextAttachment{{ID: "shot", SizeBytes: 10}}
	out, err := ReduceSourceContextToFit(fitSnapshot(10, fitComment("root", "", 10), old, anchor))
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(out.CommentThread); !reflect.DeepEqual(got, []string{"root", "anchor"}) || len(out.CommentThread[1].Attachments) != 1 {
		t.Fatalf("thread = %v anchor attachments = %v", got, out.CommentThread[1].Attachments)
	}
}

func TestReduceSourceContextToFitRefusesAnOversizedAnchor(t *testing.T) {
	_, err := ReduceSourceContextToFit(fitSnapshot(10, fitComment("root", "", 10), fitComment("anchor", "root", SourceContextMaxTextBytes+1)))
	if !errors.Is(err, ErrSourceContextTooLarge) {
		t.Fatalf("err = %v", err)
	}
}
