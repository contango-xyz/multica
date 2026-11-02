import { expect, test } from "@playwright/test";
import { createTestApi } from "./helpers";

// contango smart inbox (docs/contango/SMART-INBOX.md) at phone width. Needs a
// backend whose MULTICA_SMART_INBOX_EMAILS includes the E2E user; skipped
// otherwise.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("smart inbox works at phone width", async ({ page }) => {
  const api = await createTestApi();
  const me = await api.getMe();
  test.skip(me.smart_inbox !== true, "E2E user is not on MULTICA_SMART_INBOX_EMAILS");

  const pr = String(Date.now()).slice(-6);
  const title = `Approve merge #${pr}`;
  const key = `e2e:${pr}`;
  const status = await api.upsertInboxSignal({
    recipient_member_id: me.id,
    key,
    group: "merge",
    severity: "action_required",
    title,
    summary: "CTG-1718 · blocks 3 cards · waiting 6 h",
    body: "Short self-contained context so the merge can be approved from a phone without opening the thread.",
    actions: [{ label: "Open PR", url: "https://github.com/contango-xyz/multica/pull/1" }],
    rank: { priority: "urgent", blocks: 3, since: new Date(Date.now() - 6 * 3_600_000).toISOString() },
    push: false,
  });
  expect(status).toBe(201);

  // Log in by token; the default helper waits for desktop-only issue chrome.
  const token = api.getToken();
  const [workspace] = await api.getWorkspaces();
  if (!token || !workspace) throw new Error("E2E login did not return a token and workspace");
  const slug = workspace.slug;
  await page.addInitScript((t) => {
    localStorage.setItem("multica_token", t);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, token);
  await page.goto(`/${slug}/inbox?smart-inbox=1`, { waitUntil: "domcontentloaded" });
  // Sections by group, with count and the top entry's reason.
  const merge = page.getByRole("region", { name: /Merge approvals/ });
  await expect(merge).toBeVisible({ timeout: 30000 });
  await expect(merge.getByRole("heading", { level: 2 })).toContainText(/Merge approvals · \d+ · Urgent · blocks 3/);
  await expect(page.getByRole("heading", { name: /Waiting on you/ })).toHaveCount(0);
  const row = page.getByRole("button", { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await expect(merge.getByRole("img", { name: "Needs you" }).first()).toBeVisible();

  // Classic's header tools are still there, plus the group filter.
  await expect(page.getByRole("button", { name: "Filter inbox" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter by group" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inbox actions" })).toBeVisible();
  // Section actions and the per-row archive are reachable by touch at 44px.
  const sectionMenu = merge.getByRole("button", { name: "Section actions" });
  expect((await sectionMenu.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  const rowArchive = merge.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: "Archive" });
  await expect(rowArchive).toBeVisible();
  expect((await rowArchive.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noHorizontalScroll()).toBe(true);
  const rowBox = await row.boundingBox();
  expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const action = merge.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: "Open PR" });
  expect((await action.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "test-results/smart-inbox-390-list.png", fullPage: true });

  await row.click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
  await page.screenshot({ path: "test-results/smart-inbox-390-detail.png", fullPage: true });

  // The remembered opt-in survives a reload without the param.
  await page.goto(`/${slug}/inbox`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: /Merge approvals/ })).toBeVisible({ timeout: 30000 });
  expect(await api.resolveInboxSignal({ recipient_member_id: me.id, key })).toBe(200);
});
