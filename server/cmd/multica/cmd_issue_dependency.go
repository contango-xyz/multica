package main

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// multica issue dependency {list|add|remove} (contango): "issue X is blocked by
// issue Y" as data. Issues are given as identifiers (CTG-42) or UUIDs.

var issueDependencyCmd = &cobra.Command{
	Use:     "dependency",
	Aliases: []string{"dependencies", "dep"},
	Short:   "Manage what an issue is blocked by",
}

var issueDependencyListCmd = &cobra.Command{
	Use:   "list <issue>",
	Short: "Show what an issue is blocked by and what it blocks",
	Args:  exactArgs(1),
	RunE:  runIssueDependencyList,
}

var issueDependencyAddCmd = &cobra.Command{
	Use:   "add <issue> --blocked-by <issue>",
	Short: "Record that an issue is blocked by another issue",
	Args:  exactArgs(1),
	RunE:  runIssueDependencyAdd,
}

var issueDependencyRemoveCmd = &cobra.Command{
	Use:   "remove <issue> --blocked-by <issue>",
	Short: "Remove a blocked-by dependency",
	Args:  exactArgs(1),
	RunE:  runIssueDependencyRemove,
}

func init() {
	issueDependencyCmd.AddCommand(issueDependencyListCmd, issueDependencyAddCmd, issueDependencyRemoveCmd)
	for _, c := range []*cobra.Command{issueDependencyListCmd, issueDependencyAddCmd, issueDependencyRemoveCmd} {
		c.Flags().String("output", "table", "Output format: table or json")
	}
	issueDependencyAddCmd.Flags().String("blocked-by", "", "The issue this one is blocked by (required)")
	issueDependencyRemoveCmd.Flags().String("blocked-by", "", "The blocking issue to remove (required)")
	_ = issueDependencyAddCmd.MarkFlagRequired("blocked-by")
	_ = issueDependencyRemoveCmd.MarkFlagRequired("blocked-by")
	issueCmd.AddCommand(issueDependencyCmd)
}

func runIssueDependencyList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	issueRef, err := resolveIssueRef(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve issue: %w", err)
	}
	var result map[string]any
	if err := client.GetJSON(ctx, "/api/issues/"+issueRef.ID+"/dependencies", &result); err != nil {
		return fmt.Errorf("list dependencies: %w", err)
	}
	return printIssueDependencies(cmd, result)
}

func runIssueDependencyAdd(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	issueRef, blockerRef, err := resolveDependencyPair(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	var result map[string]any
	if err := client.PostJSON(ctx, "/api/issues/"+issueRef.ID+"/dependencies", map[string]any{"blocked_by": blockerRef.ID}, &result); err != nil {
		return fmt.Errorf("add dependency: %w", err)
	}
	return printIssueDependencies(cmd, result)
}

func runIssueDependencyRemove(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	issueRef, blockerRef, err := resolveDependencyPair(ctx, client, cmd, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, "/api/issues/"+issueRef.ID+"/dependencies/"+blockerRef.ID); err != nil {
		return fmt.Errorf("remove dependency: %w", err)
	}
	var result map[string]any
	if err := client.GetJSON(ctx, "/api/issues/"+issueRef.ID+"/dependencies", &result); err != nil {
		fmt.Fprintln(os.Stdout, "Dependency removed.")
		return nil
	}
	return printIssueDependencies(cmd, result)
}

func resolveDependencyPair(ctx context.Context, client *cli.APIClient, cmd *cobra.Command, issueArg string) (issueRef, blockerRef resolvedID, err error) {
	blockedBy, _ := cmd.Flags().GetString("blocked-by")
	if issueRef, err = resolveIssueRef(ctx, client, issueArg); err != nil {
		return issueRef, blockerRef, fmt.Errorf("resolve issue: %w", err)
	}
	if blockerRef, err = resolveIssueRef(ctx, client, blockedBy); err != nil {
		return issueRef, blockerRef, fmt.Errorf("resolve --blocked-by: %w", err)
	}
	return issueRef, blockerRef, nil
}

func printIssueDependencies(cmd *cobra.Command, result map[string]any) error {
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, map[string]any{"blocked_by": result["blocked_by"], "blocks": result["blocks"]})
	}
	headers := []string{"RELATION", "ISSUE", "STATUS", "TITLE"}
	var rows [][]string
	for _, side := range []struct{ key, label string }{{"blocked_by", "blocked by"}, {"blocks", "blocks"}} {
		items, _ := result[side.key].([]any)
		for _, raw := range items {
			d, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			rows = append(rows, []string{side.label, strVal(d, "identifier"), strVal(d, "status"), strVal(d, "title")})
		}
	}
	if len(rows) == 0 {
		fmt.Fprintln(os.Stdout, "No dependencies.")
		return nil
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}
