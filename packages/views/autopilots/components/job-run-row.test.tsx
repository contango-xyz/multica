import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AutopilotRun } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { JobRunRow, formatJobDuration } from "./job-run-row";

// Contango patch 22: an ops job's run in the run history.

const baseRun: AutopilotRun = {
  id: "run-1",
  autopilot_id: "ap-1",
  trigger_id: "trig-1",
  source: "schedule",
  status: "completed",
  issue_id: null,
  task_id: null,
  triggered_at: "2026-11-07T10:00:00Z",
  completed_at: "2026-11-07T10:01:05Z",
  failure_reason: null,
  trigger_payload: null,
  result: null,
  created_at: "2026-11-07T10:00:00Z",
  started_at: "2026-11-07T10:00:00Z",
  exit_code: 0,
  output_tail: "line one\nline two",
};

describe("formatJobDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatJobDuration("2026-11-07T10:00:00Z", "2026-11-07T10:00:45Z")).toBe("45s");
    expect(formatJobDuration("2026-11-07T10:00:00Z", "2026-11-07T10:03:05Z")).toBe("3m 05s");
    expect(formatJobDuration("2026-11-07T10:00:00Z", "2026-11-07T11:02:00Z")).toBe("1h 02m");
  });

  it("is null for a run that never started and counts a running one to now", () => {
    expect(formatJobDuration(null, null)).toBeNull();
    expect(formatJobDuration("2026-11-07T10:00:00Z", null, Date.parse("2026-11-07T10:00:10Z"))).toBe("10s");
  });
});

describe("JobRunRow", () => {
  it("shows status, duration and exit code, and the output tail on demand", async () => {
    const user = userEvent.setup();
    renderWithI18n(<JobRunRow run={baseRun} />);

    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(screen.getByText("took 1m 05s")).toBeInTheDocument();
    expect(screen.getByText("exit 0")).toBeInTheDocument();
    expect(screen.queryByText(/line one/)).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { expanded: false });
    await user.click(toggle);
    const output = screen.getByLabelText("Output");
    expect(output.tagName).toBe("PRE");
    expect(output).toHaveClass("font-mono");
    expect(output.textContent).toBe("line one\nline two");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the failure reason for an expired run and no output toggle", () => {
    renderWithI18n(
      <JobRunRow
        run={{
          ...baseRun,
          status: "expired",
          started_at: null,
          completed_at: "2026-11-07T10:10:00Z",
          exit_code: null,
          output_tail: null,
          failure_reason: "not claimed by the ops runner in time",
        }}
      />,
    );
    expect(screen.getByText("not claimed by the ops runner in time")).toBeInTheDocument();
    expect(screen.queryByText(/^took/)).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("says when a finished run left no output", async () => {
    const user = userEvent.setup();
    renderWithI18n(<JobRunRow run={{ ...baseRun, status: "failed", exit_code: 1, output_tail: null, failure_reason: "ops job failed (exit code 1)" }} />);
    expect(screen.getByText("ops job failed (exit code 1)")).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(screen.getByText("No output")).toBeInTheDocument();
  });
});
