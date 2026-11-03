package service

// Fitting a source context into the general limits (contango, docs/contango/
// ISSUE-ORIGIN.md). Upstream refuses a thread over the limits; the CLI paths
// (`issue create --from-comment`, `issue set-source`) instead keep the anchor
// comment and as much of the thread around it as fits, and record what they
// left out in SourceContextSnapshot.Truncated. The reduction is a pure,
// deterministic function of the full snapshot, so the create-time check and
// the detail view's change detection reproduce it exactly.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// SourceContextTruncation is what a fitted capture left out.
type SourceContextTruncation struct {
	// Comments dropped from the thread (not on the root-to-anchor path), with
	// any replies under them.
	OmittedCommentIDs []string `json:"omitted_comment_ids,omitempty"`
	// Comments on the root-to-anchor path kept as structure with their text
	// and attachments removed.
	EmptiedCommentIDs []string `json:"emptied_comment_ids,omitempty"`
	// The source issue's description and attachments were left out.
	IssueDescriptionOmitted bool `json:"issue_description_omitted,omitempty"`
	// The anchor comment's own attachments were left out.
	AnchorAttachmentsOmitted bool `json:"anchor_attachments_omitted,omitempty"`
}

// sourceContextFits reports whether a snapshot is within the general limits,
// measured as BuildSourceContext measures them.
func sourceContextFits(snapshot SourceContextSnapshot) (bool, error) {
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return false, err
	}
	count, bytes := 0, int64(0)
	for _, a := range snapshot.SourceIssue.Attachments {
		count++
		bytes += a.SizeBytes
	}
	for _, c := range snapshot.CommentThread {
		for _, a := range c.Attachments {
			count++
			bytes += a.SizeBytes
		}
	}
	return len(payload) <= SourceContextMaxTextBytes && count <= SourceContextMaxAttachments && bytes <= SourceContextMaxAttachmentBytes, nil
}

// ReduceSourceContextToFit returns the snapshot reduced to the general
// limits, in this order, stopping as soon as it fits:
//  1. drop comments off the root-to-anchor path, oldest first, each with the
//     replies under it;
//  2. empty the text and attachments of path comments other than the anchor,
//     oldest first (the root stays first, so the thread keeps its shape);
//  3. leave out the source issue's description and attachments;
//  4. leave out the anchor's attachments.
//
// ErrSourceContextTooLarge only when the anchor's text alone does not fit.
// A snapshot that already fits is returned unchanged (Truncated stays nil).
func ReduceSourceContextToFit(full SourceContextSnapshot) (SourceContextSnapshot, error) {
	snap := cloneSourceContextSnapshot(full)
	snap.Truncated = nil
	if ok, err := sourceContextFits(snap); err != nil || ok {
		return snap, err
	}
	trunc := &SourceContextTruncation{}
	snap.Truncated = trunc
	fits := func() (bool, error) { return sourceContextFits(snap) }

	// The root-to-anchor path.
	byID := make(map[string]int, len(snap.CommentThread))
	for i, c := range snap.CommentThread {
		byID[c.ID] = i
	}
	onPath := map[string]bool{}
	for id := snap.AnchorCommentID; id != ""; {
		i, ok := byID[id]
		if !ok || onPath[id] {
			break
		}
		onPath[id] = true
		if snap.CommentThread[i].ParentID == nil {
			break
		}
		id = *snap.CommentThread[i].ParentID
	}

	// 1. Off-path comments, oldest first, each with its subtree.
	for {
		victim := ""
		for _, c := range snap.CommentThread {
			if !onPath[c.ID] {
				victim = c.ID
				break
			}
		}
		if victim == "" {
			break
		}
		drop := map[string]bool{victim: true}
		for changed := true; changed; {
			changed = false
			for _, c := range snap.CommentThread {
				if c.ParentID != nil && drop[*c.ParentID] && !drop[c.ID] && !onPath[c.ID] {
					drop[c.ID], changed = true, true
				}
			}
		}
		kept := snap.CommentThread[:0:0]
		for _, c := range snap.CommentThread {
			if drop[c.ID] {
				trunc.OmittedCommentIDs = append(trunc.OmittedCommentIDs, c.ID)
				continue
			}
			kept = append(kept, c)
		}
		snap.CommentThread = kept
		if ok, err := fits(); err != nil || ok {
			return snap, err
		}
	}

	// 2. Empty path comments other than the anchor, oldest first.
	for i := range snap.CommentThread {
		c := &snap.CommentThread[i]
		if c.ID == snap.AnchorCommentID || (c.Content == "" && len(c.Attachments) == 0) {
			continue
		}
		c.Content, c.Attachments = "", []SourceContextAttachment{}
		trunc.EmptiedCommentIDs = append(trunc.EmptiedCommentIDs, c.ID)
		if ok, err := fits(); err != nil || ok {
			return snap, err
		}
	}

	// 3. The source issue's description and attachments.
	if snap.SourceIssue.Description != nil || len(snap.SourceIssue.Attachments) > 0 {
		snap.SourceIssue.Description, snap.SourceIssue.Attachments = nil, []SourceContextAttachment{}
		trunc.IssueDescriptionOmitted = true
		if ok, err := fits(); err != nil || ok {
			return snap, err
		}
	}

	// 4. The anchor's attachments.
	for i := range snap.CommentThread {
		if snap.CommentThread[i].ID == snap.AnchorCommentID && len(snap.CommentThread[i].Attachments) > 0 {
			snap.CommentThread[i].Attachments = []SourceContextAttachment{}
			trunc.AnchorAttachmentsOmitted = true
		}
	}
	if ok, err := fits(); err != nil || ok {
		return snap, err
	}
	return SourceContextSnapshot{}, ErrSourceContextTooLarge
}

// cloneAttachments copies without turning an empty slice into nil, which
// would change the JSON ([] vs null) and so the digest.
func cloneAttachments(in []SourceContextAttachment) []SourceContextAttachment {
	if in == nil {
		return nil
	}
	return append(make([]SourceContextAttachment, 0, len(in)), in...)
}

func cloneSourceContextSnapshot(s SourceContextSnapshot) SourceContextSnapshot {
	out := s
	out.SourceIssue.Attachments = cloneAttachments(s.SourceIssue.Attachments)
	if s.CommentThread != nil {
		out.CommentThread = make([]SourceContextCommentSnapshot, len(s.CommentThread))
	}
	for i, c := range s.CommentThread {
		c.Attachments = cloneAttachments(c.Attachments)
		out.CommentThread[i] = c
	}
	if s.Truncated != nil {
		t := *s.Truncated
		out.Truncated = &t
	}
	return out
}

// BuildSourceContextToFit is BuildSourceContext for the CLI paths: a thread
// over the general limits is reduced (ReduceSourceContextToFit) instead of
// refused, and only the attachments it keeps are cloned. A thread over the
// comment-count limit is still refused.
func BuildSourceContextToFit(ctx context.Context, q *db.Queries, workspaceID, anchorCommentID pgtype.UUID) (SourceContextBuild, error) {
	build, err := BuildSourceContext(ctx, q, workspaceID, anchorCommentID)
	if err == nil || !errors.Is(err, ErrSourceContextTooLarge) || build.Snapshot.AnchorCommentID == "" {
		return build, err
	}
	reduced, err := ReduceSourceContextToFit(build.Snapshot)
	if err != nil {
		return SourceContextBuild{Limits: build.Limits}, err
	}
	keep := map[string]bool{}
	for _, a := range reduced.SourceIssue.Attachments {
		keep[a.ID] = true
	}
	for _, c := range reduced.CommentThread {
		for _, a := range c.Attachments {
			keep[a.ID] = true
		}
	}
	rows := make([]db.Attachment, 0, len(keep))
	limits := SourceContextLimitUsage{CommentCount: len(reduced.CommentThread)}
	for _, row := range build.Rows {
		if keep[util.UUIDToString(row.ID)] {
			rows = append(rows, row)
			limits.AttachmentCount++
			limits.AttachmentBytes += row.SizeBytes
		}
	}
	payload, err := json.Marshal(reduced)
	if err != nil {
		return SourceContextBuild{}, fmt.Errorf("marshal source context: %w", err)
	}
	limits.TextBytes = len(payload)
	digest, err := sourceContextDigest(reduced)
	if err != nil {
		return SourceContextBuild{}, err
	}
	return SourceContextBuild{
		Snapshot: reduced,
		Digest:   digest,
		Token:    "sha256:" + digest + ":" + reduced.SourceIssue.ID,
		Limits:   limits,
		Rows:     rows,
	}, nil
}
