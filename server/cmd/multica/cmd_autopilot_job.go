package main

// Contango patch 22: `multica autopilot job-runs` wraps the ops runner's API
// (docs/contango/AUTOPILOT-JOBS.md). Output is JSON by default because the
// runner scripts parse it.

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var autopilotJobRunsCmd = &cobra.Command{
	Use:   "job-runs",
	Short: "Ops job runs (autopilots with --mode job): list, claim, finish",
}

var autopilotJobRunsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List ops job runs in the workspace (pending by default)",
	Args:  exactArgs(0),
	RunE:  runAutopilotJobRunsList,
}

var autopilotJobRunsClaimCmd = &cobra.Command{
	Use:   "claim <run-id>",
	Short: "Claim a pending ops job run (pending -> running); fails if already claimed",
	Args:  exactArgs(1),
	RunE:  runAutopilotJobRunsClaim,
}

var autopilotJobRunsFinishCmd = &cobra.Command{
	Use:   "finish <run-id>",
	Short: "Report a claimed ops job run's result (running -> succeeded/failed)",
	Args:  exactArgs(1),
	RunE:  runAutopilotJobRunsFinish,
}

func init() {
	autopilotCmd.AddCommand(autopilotJobRunsCmd)
	autopilotJobRunsCmd.AddCommand(autopilotJobRunsListCmd)
	autopilotJobRunsCmd.AddCommand(autopilotJobRunsClaimCmd)
	autopilotJobRunsCmd.AddCommand(autopilotJobRunsFinishCmd)

	autopilotJobRunsListCmd.Flags().String("status", "pending", "Run status: pending or running")
	autopilotJobRunsListCmd.Flags().Int("limit", 0, "Max runs (server default 100, max 500)")
	autopilotJobRunsListCmd.Flags().String("output", "json", "Output format: table or json")

	autopilotJobRunsClaimCmd.Flags().String("output", "json", "Output format: table or json")

	autopilotJobRunsFinishCmd.Flags().String("status", "", "succeeded or failed (required)")
	autopilotJobRunsFinishCmd.Flags().Int("exit-code", 0, "The command's exit code")
	autopilotJobRunsFinishCmd.Flags().String("output-tail", "", "Output to store (the server keeps the last 8 KiB)")
	autopilotJobRunsFinishCmd.Flags().String("output-tail-file", "", "Read the output to store from this file ('-' for stdin)")
	autopilotJobRunsFinishCmd.Flags().String("output", "json", "Output format: table or json")
}

func runAutopilotJobRunsList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	if _, err := requireWorkspaceID(cmd); err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	params := url.Values{}
	status, _ := cmd.Flags().GetString("status")
	params.Set("status", status)
	if v, _ := cmd.Flags().GetInt("limit"); v > 0 {
		params.Set("limit", fmt.Sprintf("%d", v))
	}
	var resp struct {
		Runs  []map[string]any `json:"runs"`
		Total int              `json:"total"`
	}
	if err := client.GetJSON(ctx, "/api/autopilot/job-runs?"+params.Encode(), &resp); err != nil {
		return fmt.Errorf("list job runs: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, resp)
	}
	headers := []string{"ID", "JOB", "TITLE", "STATUS", "FIRED_AT"}
	rows := make([][]string, 0, len(resp.Runs))
	for _, r := range resp.Runs {
		rows = append(rows, []string{strVal(r, "id"), strVal(r, "job_name"), strVal(r, "title"), strVal(r, "status"), strVal(r, "fired_at")})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

func printJobRun(cmd *cobra.Command, run map[string]any) error {
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, run)
	}
	cli.PrintTable(os.Stdout, []string{"ID", "JOB", "STATUS", "STARTED_AT", "FINISHED_AT"}, [][]string{{
		strVal(run, "id"), strVal(run, "job_name"), strVal(run, "status"), strVal(run, "started_at"), strVal(run, "finished_at"),
	}})
	return nil
}

func runAutopilotJobRunsClaim(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	if _, err := requireWorkspaceID(cmd); err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var run map[string]any
	if err := client.PostJSON(ctx, "/api/autopilot/job-runs/"+url.PathEscape(args[0])+"/claim", nil, &run); err != nil {
		return fmt.Errorf("claim job run: %w", err)
	}
	return printJobRun(cmd, run)
}

func runAutopilotJobRunsFinish(cmd *cobra.Command, args []string) error {
	status, _ := cmd.Flags().GetString("status")
	if status != "succeeded" && status != "failed" {
		return fmt.Errorf("--status must be succeeded or failed")
	}
	body := map[string]any{"status": status}
	if cmd.Flags().Changed("exit-code") {
		v, _ := cmd.Flags().GetInt("exit-code")
		body["exit_code"] = v
	}
	tail, _ := cmd.Flags().GetString("output-tail")
	tailFile, _ := cmd.Flags().GetString("output-tail-file")
	if tail != "" && tailFile != "" {
		return fmt.Errorf("--output-tail and --output-tail-file are mutually exclusive")
	}
	if tailFile != "" {
		var data []byte
		var err error
		if tailFile == "-" {
			data, err = io.ReadAll(os.Stdin)
		} else {
			data, err = os.ReadFile(tailFile)
		}
		if err != nil {
			return fmt.Errorf("read --output-tail-file: %w", err)
		}
		tail = string(data)
	}
	if len(tail) > 8192 {
		// The server truncates too; trimming here keeps the request small.
		// Start on a rune boundary so the tail stays valid UTF-8.
		start := len(tail) - 8192
		for start < len(tail) && tail[start]&0xC0 == 0x80 {
			start++
		}
		tail = tail[start:]
	}
	if tail != "" || cmd.Flags().Changed("output-tail") {
		body["output_tail"] = tail
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	if _, err := requireWorkspaceID(cmd); err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var run map[string]any
	if err := client.PostJSON(ctx, "/api/autopilot/job-runs/"+url.PathEscape(args[0])+"/finish", body, &run); err != nil {
		return fmt.Errorf("finish job run: %w", err)
	}
	return printJobRun(cmd, run)
}
