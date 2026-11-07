"use client";

// Contango patch 22: one run of an ops job (execution_mode "job") in the
// autopilot's run history. Status, fire time, duration and exit code on the
// row; the runner's output tail opens below it in monospace.

import { useState } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  XCircle,
} from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import type { AutopilotRun } from "@multica/core/types";
import { formatInTimeZone } from "../../common/format-in-time-zone";
import { useT } from "../../i18n";

type JobRunStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "expired";

const JOB_RUN_VISUAL: Record<JobRunStatus, { color: string; icon: typeof CheckCircle2; spin?: boolean }> = {
  pending: { color: "text-info", icon: Clock },
  running: { color: "text-info", icon: Loader2, spin: true },
  completed: { color: "text-success", icon: CheckCircle2 },
  failed: { color: "text-destructive", icon: XCircle },
  skipped: { color: "text-muted-foreground", icon: Ban },
  expired: { color: "text-muted-foreground", icon: Ban },
};

/** "45s", "3m 05s", "1h 02m"; null when the run never started. */
export function formatJobDuration(startedAt: string | null | undefined, finishedAt: string | null | undefined, now = Date.now()): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const total = Math.max(0, Math.round((end - start) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

export function JobRunRow({ run }: { run: AutopilotRun }) {
  const { t, i18n } = useT("autopilots");
  const [open, setOpen] = useState(false);
  const status: JobRunStatus =
    run.status in JOB_RUN_VISUAL ? (run.status as JobRunStatus) : "pending";
  const visual = JOB_RUN_VISUAL[status];
  const StatusIcon = visual.icon;
  const statusLabel = t(($) => $.run_status[status]);
  const duration = formatJobDuration(run.started_at, run.completed_at);
  const hasOutput = typeof run.output_tail === "string" && run.output_tail.length > 0;
  const finished = status === "completed" || status === "failed";
  const ToggleIcon = open ? ChevronDown : ChevronRight;

  const detail =
    status === "skipped" || status === "expired" || (status === "failed" && !hasOutput)
      ? run.failure_reason || statusLabel
      : statusLabel;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!finished}
        aria-expanded={finished ? open : undefined}
        className="flex min-h-10 w-full items-center gap-3 px-3 py-2 text-left text-body transition-colors hover:bg-accent/30 disabled:cursor-default"
      >
        <span className="flex shrink-0" title={statusLabel}>
          <StatusIcon aria-hidden="true" className={cn("size-4", visual.color, visual.spin && "animate-spin")} />
          <span className="sr-only">{statusLabel}</span>
        </span>
        <span className="w-28 shrink-0 text-caption tabular-nums text-muted-foreground">
          {formatInTimeZone(run.triggered_at || run.created_at, undefined, i18n.language)}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", status === "failed" ? "text-destructive" : "text-foreground")}>
          {detail}
        </span>
        {duration && (
          <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
            {t(($) => $.run.job.duration, { duration })}
          </span>
        )}
        {run.exit_code != null && (
          <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
            {t(($) => $.run.job.exit_code, { code: run.exit_code })}
          </span>
        )}
        <span className="shrink-0 text-caption text-muted-foreground">
          {t(($) => $.run_source[run.source as "schedule" | "manual" | "webhook" | "api"]) ?? run.source}
        </span>
        {finished && <ToggleIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      </button>
      {finished && open && (
        <div className="border-t bg-muted/20 px-3 py-2">
          {hasOutput ? (
            <pre
              aria-label={t(($) => $.run.job.output)}
              className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-caption text-foreground"
            >
              {run.output_tail}
            </pre>
          ) : (
            <p className="text-caption text-muted-foreground">{t(($) => $.run.job.no_output)}</p>
          )}
        </div>
      )}
    </div>
  );
}
