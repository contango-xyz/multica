package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// Role mention group commands (contango patch 48): @devops, @fe, ... Mentioning a
// group notifies its people on duty; `on-duty` shows who that is right now.

var groupCmd = &cobra.Command{
	Use:   "group",
	Short: "Role mention groups (@devops, @fe, ...): who a group mention reaches",
}

var groupListCmd = &cobra.Command{
	Use:   "list",
	Short: "Every group with its members, who is away and who is on duty",
	RunE:  runGroupList,
}

var groupGetCmd = &cobra.Command{
	Use:   "get <handle or id>",
	Short: "One group, with the mention text to paste into a comment",
	Args:  exactArgs(1),
	RunE:  runGroupGet,
}

var groupOnDutyCmd = &cobra.Command{
	Use:   "on-duty <handle or id>",
	Short: "Who a mention of the group reaches now (time off skipped, then backups, then the fallback)",
	Args:  exactArgs(1),
	RunE:  runGroupOnDuty,
}

var groupCreateCmd = &cobra.Command{
	Use:   "create <handle>",
	Short: "Create a group (admins)",
	Args:  exactArgs(1),
	RunE:  runGroupCreate,
}

var groupUpdateCmd = &cobra.Command{
	Use:   "update <handle or id>",
	Short: "Change a group's handle, name, description or fallback (admins)",
	Args:  exactArgs(1),
	RunE:  runGroupUpdate,
}

var groupArchiveCmd = &cobra.Command{
	Use:   "archive <handle or id>",
	Short: "Archive a group: its mentions stop notifying (admins)",
	Args:  exactArgs(1),
	RunE:  runGroupArchive,
}

var groupMembersCmd = &cobra.Command{
	Use:   "members",
	Short: "Change who is in a group (admins)",
}

var groupMembersSetCmd = &cobra.Command{
	Use:   "set <handle or id> <member>...",
	Short: "Replace the members with this ordered list (name, email, @handle or id)",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runGroupMembersSet,
}

func init() {
	groupCmd.AddCommand(groupListCmd, groupGetCmd, groupOnDutyCmd, groupCreateCmd, groupUpdateCmd, groupArchiveCmd, groupMembersCmd)
	groupMembersCmd.AddCommand(groupMembersSetCmd)
	for _, c := range []*cobra.Command{groupCreateCmd, groupUpdateCmd} {
		c.Flags().String("name", "", "Display name, e.g. \"DevOps / AWS\"")
		c.Flags().String("description", "", "What to ask this group")
		c.Flags().String("fallback", "", "Who gets it when every member and backup is away (member); \"none\" clears it")
	}
	groupUpdateCmd.Flags().String("handle", "", "New handle")
	groupOnDutyCmd.Flags().Bool("first", false, "Print only the first person's user id")
}

func groupPath(client *cli.APIClient, suffix string) string {
	p := "/api/groups" + suffix
	if client.WorkspaceID != "" {
		p += "?" + url.Values{"workspace_id": {client.WorkspaceID}}.Encode()
	}
	return p
}

func groupRef(ref string) string {
	return "/" + url.PathEscape(strings.ToLower(strings.TrimLeft(strings.TrimSpace(ref), "@＠")))
}

func groupGet(cmd *cobra.Command, suffix string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var out map[string]any
	if err := client.GetJSON(ctx, groupPath(client, suffix), &out); err != nil {
		return fmt.Errorf("group: %w", err)
	}
	return cli.PrintJSON(os.Stdout, out)
}

func runGroupList(cmd *cobra.Command, _ []string) error { return groupGet(cmd, "") }

func runGroupGet(cmd *cobra.Command, args []string) error { return groupGet(cmd, groupRef(args[0])) }

func runGroupOnDuty(cmd *cobra.Command, args []string) error {
	first, _ := cmd.Flags().GetBool("first")
	if !first {
		return groupGet(cmd, groupRef(args[0])+"/on-duty")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var out map[string]any
	if err := client.GetJSON(ctx, groupPath(client, groupRef(args[0])+"/on-duty"), &out); err != nil {
		return fmt.Errorf("group: %w", err)
	}
	fmt.Fprintln(os.Stdout, strVal(out, "first"))
	return nil
}

// groupBody reads --name/--description/--fallback; only flags that were set are sent.
func groupBody(cmd *cobra.Command, ctx context.Context, client *cli.APIClient) (map[string]any, error) {
	body := map[string]any{}
	for _, f := range []string{"name", "description", "handle"} {
		if cmd.Flags().Lookup(f) != nil && cmd.Flags().Changed(f) {
			body[f], _ = cmd.Flags().GetString(f)
		}
	}
	if cmd.Flags().Changed("fallback") {
		v, _ := cmd.Flags().GetString("fallback")
		if v == "none" || v == "" {
			body["fallback_user_id"] = ""
		} else {
			_, id, err := resolveAssignee(ctx, client, v, memberOnlyKinds)
			if err != nil {
				return nil, fmt.Errorf("resolve --fallback: %w", err)
			}
			body["fallback_user_id"] = id
		}
	}
	return body, nil
}

func runGroupCreate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	body, err := groupBody(cmd, ctx, client)
	if err != nil {
		return err
	}
	body["handle"] = strings.TrimLeft(args[0], "@")
	if _, ok := body["name"]; !ok {
		body["name"] = body["handle"]
	}
	var out map[string]any
	if err := client.PostJSON(ctx, groupPath(client, ""), body, &out); err != nil {
		return fmt.Errorf("create group: %w", err)
	}
	return cli.PrintJSON(os.Stdout, out)
}

func runGroupUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	body, err := groupBody(cmd, ctx, client)
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to change: pass --handle, --name, --description or --fallback")
	}
	var out map[string]any
	if err := client.PatchJSON(ctx, groupPath(client, groupRef(args[0])), body, &out); err != nil {
		return fmt.Errorf("update group: %w", err)
	}
	return cli.PrintJSON(os.Stdout, out)
}

func runGroupArchive(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	if err := client.DeleteJSON(ctx, groupPath(client, groupRef(args[0]))); err != nil {
		return fmt.Errorf("archive group: %w", err)
	}
	fmt.Fprintln(os.Stdout, "archived")
	return nil
}

func runGroupMembersSet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	ids := make([]string, 0, len(args)-1)
	for _, ref := range args[1:] {
		_, id, err := resolveAssignee(ctx, client, ref, memberOnlyKinds)
		if err != nil {
			return fmt.Errorf("resolve %q: %w", ref, err)
		}
		ids = append(ids, id)
	}
	var out map[string]any
	if err := client.PutJSON(ctx, groupPath(client, groupRef(args[0])+"/members"), map[string]any{"user_ids": ids}, &out); err != nil {
		return fmt.Errorf("set group members: %w", err)
	}
	return cli.PrintJSON(os.Stdout, out)
}

// resolveGroupHandle returns the id and handle of the group named by ref (@devops),
// or ok=false when no group has that handle.
func resolveGroupHandle(ctx context.Context, client *cli.APIClient, ref string) (id, handle string, ok bool, err error) {
	var out struct {
		Groups []struct {
			ID     string `json:"id"`
			Handle string `json:"handle"`
		} `json:"groups"`
	}
	if err := client.GetJSON(ctx, groupPath(client, ""), &out); err != nil {
		return "", "", false, err
	}
	want := strings.ToLower(strings.TrimLeft(strings.TrimSpace(ref), "@＠"))
	for _, g := range out.Groups {
		if g.Handle == want || g.ID == want {
			return g.ID, g.Handle, true, nil
		}
	}
	return "", "", false, nil
}
