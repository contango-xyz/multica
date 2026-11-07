package main

// Contango patch 22: expires ops-job runs nobody claimed within
// service.AutopilotJobClaimWindow. Claim and list also expire inline, so this
// sweep only keeps the run history honest when the runner is down.

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
)

const autopilotJobExpireInterval = time.Minute

func runAutopilotJobExpirer(ctx context.Context, svc *service.AutopilotService) {
	ticker := time.NewTicker(autopilotJobExpireInterval)
	defer ticker.Stop()
	for {
		if n, err := svc.ExpireStaleAutopilotJobRuns(ctx, pgtype.UUID{}, pgtype.UUID{}); err != nil {
			if ctx.Err() == nil {
				slog.Warn("autopilot job expirer failed", "error", err)
			}
		} else if n > 0 {
			slog.Info("autopilot job expirer expired runs", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
