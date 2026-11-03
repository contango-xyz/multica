package service

// Linking an issue to the comment it came from without making it a sub-issue
// (contango, docs/contango/PATCHES.md). The UI's comment-to-sub-issue flow
// captures the same snapshot but always parents the new issue under the
// source; the CLI's `--from-comment` and `issue set-source` record the source
// only.

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ErrSourceTargetIssueNotFound: the issue to attach a source to is gone.
var ErrSourceTargetIssueNotFound = errors.New("issue not found")

// lockAndVerifySourceContext locks the source issue and the anchor's comment
// path, then confirms the capture still matches what is stored, inside the
// caller's transaction.
func lockAndVerifySourceContext(ctx context.Context, qtx *db.Queries, workspaceID pgtype.UUID, capture SourceContextCapture) error {
	if _, err := qtx.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{
		ID: capture.SourceIssueID, WorkspaceID: workspaceID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSourceIssueDeleted
		}
		return fmt.Errorf("lock source issue: %w", err)
	}
	locked, err := qtx.LockCommentAncestorPath(ctx, db.LockCommentAncestorPathParams{
		CommentID: capture.AnchorCommentID, WorkspaceID: workspaceID,
		IssueID: capture.SourceIssueID,
	})
	if err != nil {
		return fmt.Errorf("lock anchor comment thread: %w", err)
	}
	if len(locked) == 0 {
		return ErrAnchorCommentDeleted
	}
	build := BuildSourceContext
	if capture.FitToLimits {
		build = BuildSourceContextToFit
	}
	current, err := build(ctx, qtx, workspaceID, capture.AnchorCommentID)
	if err != nil {
		return err
	}
	if current.Digest != capture.Digest {
		return ErrSourceContextChanged
	}
	return nil
}

// SourceContextAttachResult is what AttachSourceContext changed.
type SourceContextAttachResult struct {
	Issue db.Issue
	// ReplacedObjectURLs are the storage objects of a source context that
	// `force` replaced. Their deletion intents are recorded in the same
	// transaction; the caller deletes them best-effort after commit.
	ReplacedObjectURLs []string
}

// AttachSourceContext records capture as the source of an existing issue.
// An issue keeps at most one source: an existing one is refused with
// ErrSourceContextAlreadyAttached unless force, which replaces it.
func (s *IssueService) AttachSourceContext(ctx context.Context, workspaceID, issueID pgtype.UUID, capture SourceContextCapture, originTaskID pgtype.UUID, force bool, storageKeyFromURL func(string) string) (SourceContextAttachResult, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return SourceContextAttachResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)

	// Lock order matches create: source first, then the target.
	if err := lockAndVerifySourceContext(ctx, qtx, workspaceID, capture); err != nil {
		return SourceContextAttachResult{}, err
	}
	issue, err := qtx.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{ID: issueID, WorkspaceID: workspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceContextAttachResult{}, ErrSourceTargetIssueNotFound
	}
	if err != nil {
		return SourceContextAttachResult{}, fmt.Errorf("lock target issue: %w", err)
	}
	var result SourceContextAttachResult
	existing, err := qtx.GetIssueSourceContextByIssue(ctx, db.GetIssueSourceContextByIssueParams{WorkspaceID: workspaceID, IssueID: issueID})
	switch {
	case err == nil:
		if !force {
			return SourceContextAttachResult{}, ErrSourceContextAlreadyAttached
		}
		urls, err := detachSourceContext(ctx, qtx, workspaceID, issueID, existing, storageKeyFromURL)
		if err != nil {
			return SourceContextAttachResult{}, err
		}
		result.ReplacedObjectURLs = urls
	case !errors.Is(err, pgx.ErrNoRows):
		return SourceContextAttachResult{}, fmt.Errorf("load issue source context: %w", err)
	}
	if _, err := PersistSourceContext(ctx, qtx, capture, issueID, originTaskID); err != nil {
		return SourceContextAttachResult{}, fmt.Errorf("persist source context: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return SourceContextAttachResult{}, fmt.Errorf("commit: %w", err)
	}
	result.Issue = issue
	return result, nil
}

// detachSourceContext removes an attached source context and its cloned
// attachments the way issue deletion does: durable deletion intents first,
// then the rows. Returns the clone URLs to delete after commit.
func detachSourceContext(ctx context.Context, qtx *db.Queries, workspaceID, issueID pgtype.UUID, existing db.IssueSourceContext, storageKeyFromURL func(string) string) ([]string, error) {
	clones, err := qtx.ListAttachmentsBySourceContext(ctx, db.ListAttachmentsBySourceContextParams{
		WorkspaceID: workspaceID, SourceContextID: existing.ID,
	})
	if err != nil {
		return nil, fmt.Errorf("list source context attachments: %w", err)
	}
	if storageKeyFromURL != nil {
		for _, clone := range clones {
			key := storageKeyFromURL(clone.Url)
			if key == "" {
				continue
			}
			if _, err := qtx.RecordSourceContextDeletionObjectIntent(ctx, db.RecordSourceContextDeletionObjectIntentParams{
				StorageKey: key, WorkspaceID: workspaceID, SourceContextID: existing.ID,
				AttachmentID: clone.ID, ObjectUrl: clone.Url,
			}); err != nil {
				return nil, fmt.Errorf("record source context delete intent: %w", err)
			}
		}
	}
	deleted, err := qtx.DeleteAttachmentsBySourceContext(ctx, db.DeleteAttachmentsBySourceContextParams{WorkspaceID: workspaceID, SourceContextID: existing.ID})
	if err != nil {
		return nil, fmt.Errorf("delete source context attachments: %w", err)
	}
	if _, err := qtx.DeleteIssueSourceContextByIssue(ctx, db.DeleteIssueSourceContextByIssueParams{WorkspaceID: workspaceID, IssueID: issueID}); err != nil {
		return nil, fmt.Errorf("delete issue source context: %w", err)
	}
	urls := make([]string, 0, len(deleted))
	for _, d := range deleted {
		urls = append(urls, d.Url)
	}
	return urls, nil
}
