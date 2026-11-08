package main

// Contango patch 27: removes "wakeup now" rules a week after they finish.

import (
	"context"
	"log/slog"
	"time"

	"github.com/multica-ai/multica/server/internal/service"
)

const hiddenWakeupSweepInterval = time.Hour

func runHiddenWakeupSweeper(ctx context.Context, svc *service.IssueWakeupService) {
	ticker := time.NewTicker(hiddenWakeupSweepInterval)
	defer ticker.Stop()
	for {
		if n, err := svc.SweepHiddenWakeups(ctx, time.Now()); err != nil {
			if ctx.Err() == nil {
				slog.Warn("hidden wakeup sweep failed", "error", err)
			}
		} else if n > 0 {
			slog.Info("hidden wakeup sweep removed rules", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
