package main

// `multica issue ask`: asks as real objects (contango patch 30,
// docs/contango/PATCHES.md).

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func init() { issueCmd.AddCommand(newIssueAskCommand()) }

func newIssueAskCommand() *cobra.Command {
	ask := &cobra.Command{Use: "ask", Short: "Create and manage asks to a person or the operator"}

	create := &cobra.Command{Use: "create <issue-id>", Args: cobra.ExactArgs(1), Short: "Post an ask: its comment and its record, together", RunE: runIssueAskCreate}
	create.Long = "Posts a [NEEDS HUMAN] (or, with --to operator, [NEEDS OPERATOR]) comment in the usual format and records the ask. A person's reply in the ask's own thread answers it; any other comment leaves it open."
	create.Flags().String("to", "", "Who is asked: @handle (member) or operator")
	create.Flags().String("kind", "", "merge, decision, access, admission or tech_owner (operator asks: operator, or omit)")
	create.Flags().String("topic", "", "One-line topic")
	create.Flags().StringArray("reply", nil, "An accepted reply, repeatable; \"Label=reply text\" sets a button label")
	create.Flags().String("recommend", "", "The reply you recommend (must be one of --reply)")
	create.Flags().String("recommend-reason", "", "Why you recommend it")
	create.Flags().String("default", "", "Reply applied if nobody answers (decision asks; needs --reversible)")
	create.Flags().Bool("reversible", false, "The default can be undone")
	create.Flags().String("default-why", "", "Why there is no default (rendered as `none (irreversible: ...)`)")
	create.Flags().Bool("tech", false, "A technical ask ([TECH] after the tag)")
	create.Flags().String("where", "", "Where we are")
	create.Flags().String("why", "", "Why you're asked")
	create.Flags().String("approving", "", "What you are approving")
	create.Flags().String("risk", "", "Risk")
	create.Flags().String("links", "", "Links, evidence last")
	create.Flags().String("last-line", "", "Operator asks: the failing tool's exact last line")
	create.Flags().String("diagnosis", "", "Operator asks: your diagnosis")
	create.Flags().String("fix", "", "Operator asks: the fix you suggest")
	create.Flags().String("pr-id", "", "Linked pull request UUID")
	create.Flags().String("expires-at", "", "Stop asking at this RFC3339 time")
	create.Flags().String("expires-in", "", "Stop asking after this wait, e.g. 72h")
	create.Flags().String("parent", "", "Parent comment ID to reply under. A comment-triggered agent run must reply under its trigger comment")
	create.Flags().String("output", "json", "Output format: json")
	ask.AddCommand(create)

	list := &cobra.Command{Use: "list <issue-id>", Args: cobra.ExactArgs(1), Short: "List a card's asks", RunE: runIssueAskList}
	list.Flags().String("state", "", "Only this state (open, answered, withdrawn, expired)")
	list.Flags().Bool("oldest-open", false, "Only the card's oldest open ask")
	list.Flags().String("output", "table", "Output format: table or json")
	ask.AddCommand(list)

	ask.AddCommand(&cobra.Command{Use: "get <ask-id>", Args: cobra.ExactArgs(1), Short: "Show one ask", RunE: runIssueAskGet})

	resolve := &cobra.Command{Use: "resolve <ask-id>", Args: cobra.ExactArgs(1), Short: "Close an ask with an outcome (agents: only their own)", RunE: runIssueAskResolve}
	resolve.Flags().String("via", "", "status_move, pr_approved, default_applied or ops")
	resolve.Flags().String("text", "", "The answer")
	resolve.Flags().String("comment", "", "Comment carrying the answer")
	ask.AddCommand(resolve)

	withdraw := &cobra.Command{Use: "withdraw <ask-id>", Args: cobra.ExactArgs(1), Short: "Take an ask back (agents: only their own)", RunE: runIssueAskWithdraw}
	withdraw.Flags().String("reason", "", "Why it no longer needs an answer")
	ask.AddCommand(withdraw)
	return ask
}

// askReplyOption reads a --reply value: "agree", or "Label=reply" when the
// button should read differently from the literal reply.
func askReplyOption(raw string) map[string]string {
	if label, reply, ok := strings.Cut(raw, "="); ok && strings.TrimSpace(label) != "" && strings.TrimSpace(reply) != "" {
		return map[string]string{"label": strings.TrimSpace(label), "reply": strings.TrimSpace(reply)}
	}
	return map[string]string{"label": strings.TrimSpace(raw), "reply": strings.TrimSpace(raw)}
}

func runIssueAskCreate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	ref, err := resolveIssueRef(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve issue: %w", err)
	}

	to, _ := cmd.Flags().GetString("to")
	if to == "" {
		return fmt.Errorf("--to is required: @handle or operator")
	}
	kind, _ := cmd.Flags().GetString("kind")
	body := map[string]any{}
	if strings.EqualFold(strings.TrimSpace(to), "operator") {
		if kind == "" {
			kind = "operator"
		}
		body["addressee_type"], body["addressee_role"] = "role", "operator"
	} else {
		typ, id, err := resolveAssignee(ctx, client, to, memberOnlyKinds)
		if err != nil {
			return fmt.Errorf("resolve --to: %w", err)
		}
		body["addressee_type"], body["addressee_id"] = typ, id
	}
	body["kind"] = kind

	var options []map[string]string
	replies, _ := cmd.Flags().GetStringArray("reply")
	for _, r := range replies {
		options = append(options, askReplyOption(r))
	}
	if options != nil {
		body["options"] = options
	}
	for flag, key := range map[string]string{
		"topic": "topic", "recommend": "recommended", "recommend-reason": "recommend_reason", "default": "default_option",
		"default-why": "default_why", "where": "where", "why": "why_asked", "approving": "approving", "risk": "risk",
		"links": "links", "last-line": "last_line", "diagnosis": "diagnosis", "fix": "fix", "pr-id": "pr_id", "parent": "parent_id",
	} {
		if v, _ := cmd.Flags().GetString(flag); v != "" {
			body[key] = v
		}
	}
	reversible, _ := cmd.Flags().GetBool("reversible")
	tech, _ := cmd.Flags().GetBool("tech")
	body["reversible"], body["tech"] = reversible, tech

	expiresAt, _ := cmd.Flags().GetString("expires-at")
	expiresIn, _ := cmd.Flags().GetString("expires-in")
	if expiresAt != "" && expiresIn != "" {
		return fmt.Errorf("--expires-at and --expires-in cannot be combined")
	}
	if expiresAt != "" {
		if _, err := time.Parse(time.RFC3339, expiresAt); err != nil {
			return fmt.Errorf("--expires-at must be RFC3339: %w", err)
		}
		body["expires_at"] = expiresAt
	}
	if expiresIn != "" {
		d, err := time.ParseDuration(expiresIn)
		if err != nil {
			return fmt.Errorf("--expires-in: %w", err)
		}
		body["expires_at"] = time.Now().Add(d).UTC().Format(time.RFC3339)
	}

	var result map[string]any
	if err := client.PostJSON(ctx, "/api/issues/"+url.PathEscape(ref.ID)+"/asks", body, &result); err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runIssueAskList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	ref, err := resolveIssueRef(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve issue: %w", err)
	}
	path := "/api/issues/" + url.PathEscape(ref.ID) + "/asks"
	oldest, _ := cmd.Flags().GetBool("oldest-open")
	output, _ := cmd.Flags().GetString("output")
	var rows []map[string]any
	if oldest {
		var one map[string]any
		if err := client.GetJSON(ctx, path+"/oldest-open", &one); err != nil {
			return err
		}
		rows = []map[string]any{one}
	} else {
		if state, _ := cmd.Flags().GetString("state"); state != "" {
			path += "?state=" + url.QueryEscape(state)
		}
		if err := client.GetJSON(ctx, path, &rows); err != nil {
			return err
		}
	}
	if output == "json" {
		return cli.PrintJSON(os.Stdout, rows)
	}
	table := make([][]string, 0, len(rows))
	for _, a := range rows {
		table = append(table, []string{strVal(a, "id"), strVal(a, "state"), strVal(a, "kind"), askAddressee(a), strVal(a, "topic"), strVal(a, "created_at")})
	}
	cli.PrintTable(os.Stdout, []string{"ID", "STATE", "KIND", "TO", "TOPIC", "CREATED"}, table)
	return nil
}

func askAddressee(a map[string]any) string {
	if role := strVal(a, "addressee_role"); role != "" {
		return role
	}
	return strVal(a, "addressee_type") + ":" + strVal(a, "addressee_id")
}

func runIssueAskGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	if err := client.GetJSON(ctx, "/api/asks/"+url.PathEscape(args[0]), &result); err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runIssueAskResolve(cmd *cobra.Command, args []string) error {
	via, _ := cmd.Flags().GetString("via")
	if via == "" {
		return fmt.Errorf("--via is required: status_move, pr_approved, default_applied or ops")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	text, _ := cmd.Flags().GetString("text")
	comment, _ := cmd.Flags().GetString("comment")
	body := map[string]any{"answered_via": via, "answer_text": text, "answer_comment_id": comment}
	var result map[string]any
	if err := client.PostJSON(ctx, "/api/asks/"+url.PathEscape(args[0])+"/resolve", body, &result); err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runIssueAskWithdraw(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	reason, _ := cmd.Flags().GetString("reason")
	var result map[string]any
	if err := client.PostJSON(ctx, "/api/asks/"+url.PathEscape(args[0])+"/withdraw", map[string]any{"reason": reason}, &result); err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}
