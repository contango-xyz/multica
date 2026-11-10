package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// Availability commands (contango patch 38): who works when, who is away, and each person's backup.

var availabilityCmd = &cobra.Command{
	Use:   "availability",
	Short: "Who works when and who is away",
}

var availabilityListCmd = &cobra.Command{
	Use:   "list",
	Short: "Every member's working hours, backup and time off",
	RunE:  runAvailabilityList,
}

var availabilityGetCmd = &cobra.Command{
	Use:   "get <member name, email or id>",
	Short: "One member's availability",
	Args:  exactArgs(1),
	RunE:  runAvailabilityGet,
}

var availabilitySetCmd = &cobra.Command{
	Use:   "set",
	Short: "Set your backup person or personal iCal address",
	RunE:  runAvailabilitySet,
}

var availabilityOffCmd = &cobra.Command{
	Use:   "off <YYYY-MM-DD> [<YYYY-MM-DD>]",
	Short: "Add your own time off (end date inclusive)",
	Args:  cobra.RangeArgs(1, 2),
	RunE:  runAvailabilityOff,
}

var availabilityImportCmd = &cobra.Command{
	Use:   "import",
	Short: "Replace one calendar source's time off (admins; JSON on stdin)",
	RunE:  runAvailabilityImport,
}

var availabilitySourcesCmd = &cobra.Command{
	Use:   "ical-sources",
	Short: "Personal iCal addresses to import (admins)",
	RunE:  runAvailabilitySources,
}

func init() {
	availabilityCmd.AddCommand(availabilityListCmd, availabilityGetCmd, availabilitySetCmd, availabilityOffCmd,
		availabilityImportCmd, availabilitySourcesCmd)
	for _, c := range []*cobra.Command{availabilityListCmd, availabilityGetCmd} {
		c.Flags().Int("days", 14, "Days ahead to include (0..120)")
	}
	availabilitySetCmd.Flags().String("backup", "", "Backup member (name, email or id); \"none\" clears it")
	availabilitySetCmd.Flags().String("ical-file", "", "File holding your personal iCal secret address; \"none\" clears it")
	availabilityOffCmd.Flags().Bool("half-day", false, "Only half the day")
	availabilityOffCmd.Flags().String("label", "", "Short note, e.g. \"holiday\"")
}

func availabilityPath(cmd *cobra.Command, client *cli.APIClient) string {
	params := url.Values{}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	if days, err := cmd.Flags().GetInt("days"); err == nil {
		params.Set("days", fmt.Sprint(days))
	}
	return "/api/availability?" + params.Encode()
}

func fetchAvailability(cmd *cobra.Command) (*cli.APIClient, map[string]any, error) {
	client, err := newAPIClient(cmd)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var out map[string]any
	if err := client.GetJSON(ctx, availabilityPath(cmd, client), &out); err != nil {
		return nil, nil, fmt.Errorf("availability: %w", err)
	}
	return client, out, nil
}

func runAvailabilityList(cmd *cobra.Command, _ []string) error {
	_, out, err := fetchAvailability(cmd)
	if err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, out)
}

// matchMember finds one member by id, email, full name or first name (case-insensitive).
func matchMember(members []any, ref string) (map[string]any, error) {
	ref = strings.ToLower(strings.TrimSpace(ref))
	var found []map[string]any
	for _, raw := range members {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name := strings.ToLower(strVal(m, "name"))
		first, _, _ := strings.Cut(name, " ")
		email := strings.ToLower(strVal(m, "email"))
		local, _, _ := strings.Cut(email, "@")
		if ref == strVal(m, "user_id") || ref == email || ref == name {
			return m, nil
		}
		if ref == first || ref == local {
			found = append(found, m)
		}
	}
	if len(found) == 1 {
		return found[0], nil
	}
	if len(found) > 1 {
		return nil, fmt.Errorf("%q matches %d members; use the email", ref, len(found))
	}
	return nil, fmt.Errorf("no member matches %q", ref)
}

func runAvailabilityGet(cmd *cobra.Command, args []string) error {
	_, out, err := fetchAvailability(cmd)
	if err != nil {
		return err
	}
	members, _ := out["members"].([]any)
	m, err := matchMember(members, args[0])
	if err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, m)
}

func runAvailabilitySet(cmd *cobra.Command, _ []string) error {
	body := map[string]any{}
	if v, _ := cmd.Flags().GetString("backup"); v != "" {
		if v == "none" {
			body["backup_user_id"] = ""
		} else {
			_, out, err := fetchAvailability(cmd)
			if err != nil {
				return err
			}
			members, _ := out["members"].([]any)
			m, err := matchMember(members, v)
			if err != nil {
				return err
			}
			body["backup_user_id"] = strVal(m, "user_id")
		}
	}
	if f, _ := cmd.Flags().GetString("ical-file"); f != "" {
		if f == "none" {
			body["personal_ical_url"] = ""
		} else {
			raw, err := os.ReadFile(f)
			if err != nil {
				return err
			}
			body["personal_ical_url"] = strings.TrimSpace(string(raw))
		}
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to set: pass --backup and/or --ical-file")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var out map[string]any
	if err := client.PutJSON(ctx, "/api/availability/me", body, &out); err != nil {
		return fmt.Errorf("set availability: %w", err)
	}
	return cli.PrintJSON(os.Stdout, out)
}

func runAvailabilityOff(cmd *cobra.Command, args []string) error {
	body := map[string]any{"starts_on": args[0]}
	if len(args) > 1 {
		body["ends_on"] = args[1]
	}
	body["half_day"], _ = cmd.Flags().GetBool("half-day")
	body["label"], _ = cmd.Flags().GetString("label")
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var out map[string]any
	if err := client.PostJSON(ctx, "/api/availability/me/time-off", body, &out); err != nil {
		return fmt.Errorf("add time off: %w", err)
	}
	return cli.PrintJSON(os.Stdout, out)
}

func runAvailabilityImport(cmd *cobra.Command, _ []string) error {
	var body map[string]any
	if err := json.NewDecoder(os.Stdin).Decode(&body); err != nil {
		return fmt.Errorf("import: read JSON from stdin: %w", err)
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var out map[string]any
	if err := client.PutJSON(ctx, "/api/availability/import", body, &out); err != nil {
		return fmt.Errorf("import: %w", err)
	}
	return cli.PrintJSON(os.Stdout, out)
}

func runAvailabilitySources(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var out map[string]any
	if err := client.GetJSON(ctx, "/api/availability/ical-sources", &out); err != nil {
		return fmt.Errorf("ical sources: %w", err)
	}
	return cli.PrintJSON(os.Stdout, out)
}
