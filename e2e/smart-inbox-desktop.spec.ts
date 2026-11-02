import "./env";

import { expect, test } from "@playwright/test";
import pg from "pg";
import { createTestApi } from "./helpers";

// contango smart inbox (docs/contango/SMART-INBOX.md) at desktop width: Classic's
// two panes with Smart's sections. Needs a backend whose
// MULTICA_SMART_INBOX_EMAILS includes the E2E user; skipped otherwise.
test.use({ viewport: { width: 1280, height: 900 } });

test("smart inbox is Classic++ at desktop width", async ({ page }) => {
  test.setTimeout(120_000);
  const api = await createTestApi();
  const me = await api.getMe();
  test.skip(me.smart_inbox !== true, "E2E user is not on MULTICA_SMART_INBOX_EMAILS");

  const db = new pg.Client(process.env.DATABASE_URL);
  await db.connect();
  let runtimeId: string | undefined;
  let agentId: string | undefined;
  const run = String(Date.now()).slice(-6);
  const key = `e2e-desktop:${run}`;
  try {
    const workspace = (await api.getWorkspaces())[0]!;
    // Two cards: A has a merge ask AND the mention that tagged the reader
    // (one row, folded); B only has a mention (Mentions & reviews).
    const issue = await api.createIssue(`Ship the login fix ${run}`, { status: "todo" });
    const other = await api.createIssue(`Review the docs ${run}`, { status: "todo" });
    // An agent that tagged the reader and is still working on card B.
    const runtime = await db.query<{ id: string }>(
      `INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, device_info, metadata, owner_id, last_seen_at)
       VALUES ($1, $2, 'cloud', 'codex', 'online', 'E2E fixture', '{}'::jsonb, $3, now()) RETURNING id`,
      [workspace.id, `Smart inbox ${run}`, me.id],
    );
    runtimeId = runtime.rows[0]!.id;
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agent (workspace_id, name, description, instructions, runtime_mode, runtime_config, runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id)
       VALUES ($1, $2, '', '', 'cloud', '{}'::jsonb, $3, 'private', 'private', 1, $4) RETURNING id`,
      [workspace.id, `Brooks ${run}`, runtimeId, me.id],
    );
    agentId = agent.rows[0]!.id;
    await db.query(
      `INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, dispatched_at, started_at)
       VALUES ($1, $2, $3, 'running', now(), now())`,
      [agentId, runtimeId, other.id],
    );
    // A long thread, so the comment that tagged the reader starts off screen.
    const tagThread = async (issueId: string, ask: string) => {
      await db.query(
        `INSERT INTO comment (workspace_id, issue_id, author_type, author_id, content, created_at)
         SELECT $1, $2, 'member', $3, 'Progress note ' || g || E'\n\nNothing for you here yet.', now() - interval '3 hours' + g * interval '1 minute'
         FROM generate_series(1, 30) AS g`,
        [workspace.id, issueId, me.id],
      );
      const tag = await db.query<{ id: string }>(
        `INSERT INTO comment (workspace_id, issue_id, author_type, author_id, content, created_at)
         VALUES ($1, $2, 'agent', $3, $4, now() - interval '1 hour') RETURNING id`,
        [workspace.id, issueId, agentId, ask],
      );
      const commentId = tag.rows[0]!.id;
      await db.query(
        `INSERT INTO comment (workspace_id, issue_id, author_type, author_id, content, created_at)
         SELECT $1, $2, 'member', $3, 'Later note ' || g, now() - interval '50 minutes' + g * interval '1 minute'
         FROM generate_series(1, 10) AS g`,
        [workspace.id, issueId, me.id],
      );
      await db.query(
        `INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, type, severity, issue_id, title, body, actor_type, actor_id, details, created_at)
         VALUES ($1, 'member', $2, 'mentioned', 'action_required', $3, (SELECT title FROM issue WHERE id = $3), $4, 'agent', $5,
                 jsonb_build_object('comment_id', $6::text), now() - interval '1 hour')`,
        [workspace.id, me.id, issueId, ask, agentId, commentId],
      );
      return commentId;
    };
    const askA = await tagThread(issue.id, "Can you approve the merge of the login fix?");
    const askB = await tagThread(other.id, "Can you review the docs change?");
    const status = await api.upsertInboxSignal({
      recipient_member_id: me.id,
      key,
      group: "merge",
      severity: "action_required",
      issue_id: issue.id,
      title: `Approve merge #${run}`,
      summary: "CTG-1718 · blocks 3 cards · waiting 6 h",
      body: "The fix is reviewed and green; it only needs your approval.",
      actions: [{ label: "Open PR", url: "https://github.com/contango-xyz/multica/pull/1" }],
      rank: { priority: "urgent", blocks: 3, since: new Date(Date.now() - 6 * 3_600_000).toISOString() },
      push: false,
    });
    expect(status).toBe(201);

    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.goto(`/${workspace.slug}/inbox?smart-inbox=1`, { waitUntil: "domcontentloaded" });

    // The dashboard above the panes: the urgent signal is among the things to
    // do first, numbered, with its action (the order itself is unit-tested).
    const doFirst = page.getByRole("region", { name: "Do this first" });
    await expect(doFirst).toBeVisible({ timeout: 45_000 });
    const first = doFirst.getByRole("listitem").filter({ hasText: `Approve merge #${run}` });
    await expect(first).toContainText(/[123]\. Approve merge/);
    await expect(first).toContainText(/urgent · blocks 3 cards · waiting 6h/);
    await expect(first.getByRole("button", { name: /Open PR/ })).toBeVisible();
    // Card A counts once although it has a signal and a mention.
    await expect(doFirst.getByRole("listitem").filter({ hasText: issue.title })).toHaveCount(0);
    const counters = page.getByRole("group", { name: "Overview" });
    await expect(counters.getByRole("button", { name: /\d+ waiting on you/ })).toBeVisible();
    await expect(counters.getByRole("button", { name: /\d+ urgent/ })).toBeVisible();

    // Sections over Classic rows, with Classic's header tools and the smart filter.
    const merge = page.getByRole("region", { name: /Merge approvals/ });
    await expect(merge).toBeVisible({ timeout: 45_000 });
    await expect(merge.getByRole("heading")).toContainText(/Merge approvals\s·\s\d+\s·\sUrgent · blocks 3/);
    const mentions = page.getByRole("region", { name: /Mentions & reviews/ });
    await expect(page.getByRole("button", { name: "Filter inbox" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter by group" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More actions" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Switch to Classic" })).toBeVisible();

    // One row per card: card A's mention folded into its merge row, which shows
    // the agent who tagged the reader; it is not under Mentions & reviews.
    const signalRow = merge.getByRole("button", { name: new RegExp(`Approve merge #${run}`) });
    await expect(signalRow).toContainText("CTG-1718 · blocks 3 cards");
    await expect(signalRow.locator('[data-slot="avatar"]').first()).toBeVisible();
    await expect(mentions.getByRole("button", { name: new RegExp(issue.title) })).toHaveCount(0);

    // Card B's row is a Classic row: the agent's avatar, the card's status icon,
    // the agent-working indicator.
    const mentionRow = mentions.getByRole("button", { name: new RegExp(other.title) });
    await expect(mentionRow).toBeVisible();
    await expect(mentionRow.locator('[data-slot="avatar"]').first()).toBeVisible();
    await expect(mentionRow.locator('span[title="Todo"]')).toBeVisible();
    await expect(mentionRow).toContainText("Working");

    // Two panes: selecting the folded row fills the right pane, stays on
    // /inbox, and scrolls the thread to the comment that tagged the reader.
    const inboxPath = new URL(page.url()).pathname;
    await signalRow.click();
    const brief = page.getByTestId("signal-brief");
    await expect(brief).toBeVisible();
    await expect(brief).toContainText("The fix is reviewed and green");
    await expect(brief.getByRole("button", { name: /Open PR/ })).toBeVisible();
    await expect(merge).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(inboxPath);
    await expect(page.locator(`#comment-${askA}`)).toBeInViewport({ timeout: 15_000 });
    await expect(page.locator("#comment-" + askA)).toContainText("approve the merge");
    await page.screenshot({ path: "test-results/smart-inbox-1280.png" });

    // A counter filters the list: "Merge approvals" alone.
    await counters.getByRole("button", { name: /Merge approvals · \d+/ }).click();
    await expect(page.getByRole("region", { name: /Mentions & reviews/ })).toHaveCount(0);
    await counters.getByRole("button", { name: /Merge approvals · \d+/ }).click();
    await expect(page.getByRole("region", { name: /Mentions & reviews/ })).toBeVisible();

    // A mention's detail is Classic's (no brief), landing on its comment.
    await mentionRow.click();
    await expect(page.getByTestId("signal-brief")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(inboxPath);
    await expect(page.locator(`#comment-${askB}`)).toBeInViewport({ timeout: 15_000 });
    await page.screenshot({ path: "test-results/smart-inbox-1280-mention.png" });

    // Classic lands on the tagging comment too.
    await page.getByRole("button", { name: "Switch to Classic" }).click();
    await page.getByRole("button", { name: new RegExp(other.title) }).first().click();
    await expect(page.locator(`#comment-${askB}`)).toBeInViewport({ timeout: 15_000 });
    await page.getByRole("button", { name: "Switch to Smart" }).click();

    expect(await api.resolveInboxSignal({ recipient_member_id: me.id, key })).toBe(200);
  } finally {
    if (agentId) await db.query(`DELETE FROM agent_task_queue WHERE agent_id = $1`, [agentId]);
    if (agentId) await db.query(`DELETE FROM agent WHERE id = $1`, [agentId]);
    if (runtimeId) await db.query(`DELETE FROM agent_runtime WHERE id = $1`, [runtimeId]);
    await db.end();
    await api.cleanup();
  }
});
