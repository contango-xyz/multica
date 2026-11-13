import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@multica/core/types";

// t(selector, opts) -> "path" or "path:count".
vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (sel: (p: unknown) => unknown, opts?: { count?: number }) => {
      const path: string[] = [];
      const proxy: unknown = new Proxy({}, { get: (_t, k) => { path.push(String(k)); return proxy; } });
      sel(proxy);
      return path.join(".") + (opts?.count !== undefined ? `:${opts.count}` : "");
    },
  }),
}));
vi.mock("./inbox-list-item", () => ({
  // Mirrors the real row's controls (hover archive + compact menu; see inbox-list-item.test.tsx).
  InboxListItem: ({ item, onClick, onAction }: { item: InboxItem; onClick: () => void; onAction: () => void }) => (
    <div data-inbox-row-key={`else:${item.id}`}>
      <span data-testid="row-menu" />
      <button type="button" data-testid="else-row" onClick={onClick}>{item.title}</button>
      <button type="button" aria-label="list.archive_tooltip" onClick={onAction} />
    </div>
  ),
}));
// The compact row menu is Classic's (inbox-row-menu); its actions come from the page's provider.
vi.mock("./inbox-row-menu", () => ({ InboxRowMenu: () => <span data-testid="row-menu" /> }));
vi.mock("./signal-reply-button", () => ({
  SignalReplyButton: ({ reply }: { reply: { label: string } }) => <button type="button">{reply.label}</button>,
}));

import { InboxTabsView, SquadScreen } from "./smart-tabs";

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
let seq = 0;
function signal(group: string, details: Record<string, unknown> = {}, over: Partial<InboxItem> = {}): InboxItem {
  seq += 1;
  return {
    id: `s${seq}`, workspace_id: "ws", recipient_type: "member", recipient_id: "u", actor_type: "system", actor_id: null,
    type: "signal", severity: "action_required", issue_id: `card${seq}`, title: `Signal ${seq}`, body: null, issue_status: null,
    read: false, archived: false, created_at: hoursAgo(1),
    details: {
      key: `needs-human:CTG-${seq}:c${seq}`, group, summary: `CTG-${seq} · waiting`, actions: [],
      rank: { priority: "medium", blocks: 0, since: hoursAgo(1) }, ...details,
    } as unknown as InboxItem["details"],
    ...over,
  };
}

const archive = { onArchive: vi.fn(), onArchiveEntries: vi.fn(), onMarkEntriesRead: vi.fn() };

function renderTabs(items: InboxItem[]) {
  return renderTabsWith(items).onSelect;
}

function renderTabsWith(items: InboxItem[], selectedKey = "") {
  const onSelect = vi.fn();
  const onClearSelection = vi.fn();
  const client = new QueryClient();
  const view = (rows: InboxItem[], key: string) => (
    <QueryClientProvider client={client}>
      <InboxTabsView
        wsId="ws"
        items={rows}
        now={NOW}
        selectedKey={key}
        onSelect={onSelect}
        onClearSelection={onClearSelection}
        {...archive}
      />
    </QueryClientProvider>
  );
  const utils = render(view(items, selectedKey));
  const rerender = (rows: InboxItem[], key: string) => utils.rerender(view(rows, key));
  return { onSelect, onClearSelection, rerender };
}

/** The row (card) that holds `title`, found by its row key. */
function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest<HTMLElement>("[data-inbox-row-key]");
  if (!row) throw new Error(`no row for ${title}`);
  return row;
}
const archiveIn = (el: HTMLElement) => within(el).getByRole("button", { name: "list.archive_tooltip" });
const archivedIds = () => archive.onArchive.mock.calls.map((c) => c[0]);

const tab = (name: RegExp) => screen.getByRole("tab", { name });

describe("InboxTabsView", () => {
  beforeEach(() => {
    localStorage.clear();
    archive.onArchive.mockClear();
    archive.onArchiveEntries.mockClear();
    archive.onMarkEntriesRead.mockClear();
  });

  it("shows five tabs with badges on Today, Decisions and Merges only", () => {
    renderTabs([
      signal("decision"),
      signal("decision"),
      signal("merge"),
      signal("fyi", {}, { severity: "info" }),
    ]);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "smart.tabs.today3",
      "smart.tabs.decisions2",
      "smart.tabs.merges1",
      "smart.tabs.squad",
      "smart.tabs.else1",
    ]);
    expect(tab(/today/)).toHaveAttribute("aria-selected", "true");
  });

  it("Today ranks by cards freed and shows the alert banner", () => {
    const onSelect = renderTabs([
      signal("decision", { rank: { priority: "medium", blocks: 0, since: hoursAgo(2) } }, { title: "Small" }),
      signal("access", { rank: { priority: "medium", blocks: 6, since: hoursAgo(2) } }, { title: "Secrets" }),
      signal("alert", {}, { title: "Main is red" }),
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("Main is red");
    const titles = screen.getAllByRole("button", { name: /^\d\.\s?\S/ }).map((b) => b.textContent);
    expect(titles).toEqual(["1. Secrets", "2. Small"]);
    expect(screen.getByText("smart.tabs.frees:6")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "smart.tabs.open_card" })[0]!);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ title: "Secrets" }));
  });

  it("Decisions folds a re-ask and opens the brief with a default line", () => {
    renderTabs([
      signal("decision", {}, { issue_id: "c1", created_at: hoursAgo(5), title: "Old ask" }),
      signal("decision", {
        brief: { situation: "Two secrets are missing.", recommend: "Add them.", default: "" },
        replies: [{ label: "Approve: done", content: "done" }],
      }, { issue_id: "c1", title: "New ask" }),
    ]);
    fireEvent.click(tab(/decisions/));
    const row = screen.getByRole("button", { name: /New ask/ });
    expect(row).toHaveTextContent("smart.tabs.folded:2");
    expect(screen.queryByText("Old ask")).toBeNull();
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Two secrets are missing.")).toBeInTheDocument();
    expect(screen.getByText("smart.tabs.nothing_happens")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve: done" })).toBeInTheDocument();
  });

  it("Merges links Approve to the PR's GitHub review page and hides merged asks", () => {
    renderTabs([
      signal("merge", {
        merge: { pr: "#3840", url: "https://github.com/o/r/pull/3840", risk: "money: services/swap", ci: "green", review: "passed", lines: 212, files: 4, state: "open" },
      }, { title: "Approve merge #3840" }),
      signal("merge", { merge: { pr: "#3826", state: "merged" } }, { title: "Approve merge #3826" }),
      signal("merge", { key: "post-merge:CTG-9:core#3824" , merge: { pr: "#3824", post_merge: true, url: "https://github.com/o/r/pull/3824" } }, { title: "Merged without you" }),
    ]);
    fireEvent.click(tab(/merges/));
    expect(screen.queryByText("Approve merge #3826")).toBeNull();
    expect(screen.getByRole("button", { name: /approve_on_github/ })).toHaveAttribute("href", "https://github.com/o/r/pull/3840/files");
    expect(screen.getByText("money: services/swap")).toBeInTheDocument();
    expect(screen.getByText("smart.tabs.ci.green")).toBeInTheDocument();
    expect(screen.getByText("smart.tabs.merged_without_you")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review_on_github/ })).toHaveAttribute("href", "https://github.com/o/r/pull/3824/files");
  });

  // Contango patch 47: the list grid's one column must be minmax(0, 1fr). An
  // implicit `auto` column grew to Everything else's longest one-line title, so
  // overflow-x-hidden clipped the rows' right edge (hover archive, compact menu,
  // time). jsdom has no layout: this pins the class that prevents it.
  it("every tab's list is one shrinkable column, so long rows keep their archive", () => {
    renderTabs([
      signal("decision", {}, { title: "Decide" }),
      signal("fyi", {}, { severity: "info", title: "x".repeat(400) }),
    ]);
    for (const name of [/today/, /decisions/, /merges/, /else/]) {
      fireEvent.click(tab(name));
      expect(screen.getByTestId("inbox-tab-list")).toHaveClass("grid", "grid-cols-1");
    }
    expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: "list.archive_tooltip" })).toBeInTheDocument();
  });

  it("Everything else lists the rest and remembers the tab", () => {
    renderTabs([signal("fyi", {}, { severity: "info", title: "FYI one" })]);
    fireEvent.click(tab(/else/));
    expect(within(screen.getByRole("tabpanel")).getByTestId("else-row")).toHaveTextContent("FYI one");
    expect(localStorage.getItem("multica:inbox-tab")).toBe("else");
  });
});

describe("InboxTabsView archive (Smart's row and section archive on every tab)", () => {
  beforeEach(() => {
    localStorage.clear();
    archive.onArchive.mockClear();
    archive.onArchiveEntries.mockClear();
    archive.onMarkEntriesRead.mockClear();
  });

  it("Today: each ranked card has the hover archive", () => {
    renderTabs([signal("decision", {}, { id: "t1", title: "First" }), signal("merge", {}, { id: "t2", title: "Second" })]);
    fireEvent.click(archiveIn(rowOf("Second")));
    fireEvent.click(archiveIn(rowOf("First")));
    expect(archivedIds()).toEqual(["t2", "t1"]);
  });

  it("Decisions: the summary row and the brief both archive the card", () => {
    renderTabs([signal("decision", {}, { id: "d1", title: "Pick one" })]);
    fireEvent.click(tab(/decisions/));
    const row = rowOf("Pick one");
    fireEvent.click(archiveIn(row));
    expect(archivedIds()).toEqual(["d1"]);
    // Archiving from the summary does not open the brief.
    expect(within(row).getByRole("button", { name: /Pick one/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(row).getByRole("button", { name: /Pick one/ }));
    fireEvent.click(within(row).getByRole("button", { name: "smart.tabs.archive" }));
    expect(archivedIds()).toEqual(["d1", "d1"]);
  });

  it("Decisions: a row folding asks on one card archives once; asks on two cards archive both", () => {
    renderTabs([
      signal("decision", {}, { id: "a1", issue_id: "c1", created_at: hoursAgo(3), title: "Older" }),
      signal("decision", {}, { id: "a2", issue_id: "c1", title: "Newer" }),
    ]);
    fireEvent.click(tab(/decisions/));
    fireEvent.click(archiveIn(rowOf("Newer")));
    expect(archivedIds()).toEqual(["a2"]);
    expect(archive.onArchiveEntries).not.toHaveBeenCalled();
  });

  it("Merges: approval and merged-without-you cards both archive", () => {
    renderTabs([
      signal("merge", { merge: { pr: "#1", state: "open" } }, { id: "m1", title: "Approve merge #1" }),
      signal("merge", { key: "post-merge:CTG-9:core#2", merge: { pr: "#2", post_merge: true } }, { id: "m2", title: "Merged #2" }),
    ]);
    fireEvent.click(tab(/merges/));
    fireEvent.click(archiveIn(rowOf("Approve merge #1")));
    fireEvent.click(archiveIn(rowOf("Merged #2")));
    expect(archivedIds()).toEqual(["m1", "m2"]);
  });

  // Owner 2026-11-13 (contango patch 47): "stupid not having archive buttons on the cards when hover". A Today
  // "CD is red" alert banner (fix-main:…) had none. Every card type, every tab: the hover icon (revealed on
  // hover/focus only where hover exists), the compact menu for touch, and a click archives that card.
  it("every card type on every tab has the hover archive and the touch menu", () => {
    renderTabs([
      signal("alert", { key: "fix-main:core:main" }, { id: "al", issue_id: "c-al", title: "CD is red" }),
      signal("decision", {}, { id: "td", issue_id: "c-td", title: "Today ask" }),
      signal("decision", {}, { id: "g1", issue_id: "c-g", created_at: hoursAgo(3), title: "Grouped older" }),
      signal("decision", {}, { id: "g2", issue_id: "c-g", title: "Grouped newer" }),
      signal("merge", { merge: { pr: "#1", state: "open" } }, { id: "mg", issue_id: "c-mg", title: "Approve merge #1" }),
      signal("merge", { key: "post-merge:CTG-9:core#2", merge: { pr: "#2", post_merge: true } }, { id: "pm", issue_id: "c-pm", title: "Merged #2" }),
      signal("fyi", {}, { id: "fy", issue_id: "c-fy", severity: "info", title: "FYI" }),
    ]);
    const expectArchivable = (row: HTMLElement, id: string) => {
      const btn = archiveIn(row);
      expect(btn.className).toContain("[@media(hover:hover)]:group-hover:inline-flex");
      expect(btn.closest(".group")).not.toBeNull();
      expect(within(row).getByTestId("row-menu")).toBeInTheDocument();
      archive.onArchive.mockClear();
      fireEvent.click(btn);
      expect(archivedIds()).toEqual([id]);
    };
    // Today: the alert banner and the ranked cards.
    expectArchivable(rowOf("CD is red"), "al");
    expectArchivable(rowOf("Today ask"), "td");
    expectArchivable(rowOf("Grouped newer"), "g2");
    // Decisions, including a grouped (folded) row.
    fireEvent.click(tab(/decisions/));
    expectArchivable(rowOf("Today ask"), "td");
    expectArchivable(rowOf("Grouped newer"), "g2");
    // Merges: approval and merged-without-you.
    fireEvent.click(tab(/merges/));
    expectArchivable(rowOf("Approve merge #1"), "mg");
    expectArchivable(rowOf("Merged #2"), "pm");
    // Everything else: Classic's rows (the alert is listed here too).
    fireEvent.click(tab(/else/));
    const panel = screen.getByRole("tabpanel");
    for (const [title, id] of [["FYI", "fy"], ["CD is red", "al"]] as const) {
      const row = within(panel).getByText(title).closest<HTMLElement>("[data-inbox-row-key]")!;
      archive.onArchive.mockClear();
      fireEvent.click(archiveIn(row));
      expect(within(row).getByTestId("row-menu")).toBeInTheDocument();
      expect(archivedIds()).toEqual([id]);
    }
  });

  it("Everything else: rows keep Classic's archive", () => {
    renderTabs([signal("fyi", {}, { id: "e1", severity: "info", title: "FYI" })]);
    fireEvent.click(tab(/else/));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "list.archive_tooltip" }));
    expect(archivedIds()).toEqual(["e1"]);
  });

  it("a list's Archive all archives up to 3 cards at once", async () => {
    renderTabs([1, 2, 3].map((n) => signal("decision", {}, { id: `d${n}`, title: `Ask ${n}` })));
    fireEvent.click(tab(/decisions/));
    fireEvent.click(screen.getByRole("button", { name: "smart.tabs.tab_actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /smart.tabs.archive_tab/ }));
    expect(archive.onArchiveEntries).toHaveBeenCalledTimes(1);
    expect(archive.onArchiveEntries.mock.calls[0]![0].map((e: { item: InboxItem }) => e.item.id).sort()).toEqual(["d1", "d2", "d3"]);
  });

  it("a list's Archive all asks first above 3 cards", async () => {
    renderTabs([1, 2, 3, 4].map((n) => signal("fyi", {}, { id: `f${n}`, severity: "info", title: `FYI ${n}` })));
    fireEvent.click(tab(/else/));
    fireEvent.click(screen.getByRole("button", { name: "smart.tabs.tab_actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /smart.tabs.archive_tab/ }));
    expect(archive.onArchiveEntries).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("smart.tabs.confirm_archive_title:4");
    fireEvent.click(within(dialog).getByRole("button", { name: "smart.tabs.confirm_archive" }));
    expect(archive.onArchiveEntries.mock.calls[0]![0]).toHaveLength(4);
  });

  it("a list's Mark read marks every entry it shows", async () => {
    renderTabs([signal("decision", {}, { id: "r1", title: "Read me" })]);
    fireEvent.click(tab(/decisions/));
    fireEvent.click(screen.getByRole("button", { name: "smart.tabs.tab_actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /smart.tabs.mark_tab_read/ }));
    expect(archive.onMarkEntriesRead.mock.calls[0]![0].map((e: { item: InboxItem }) => e.item.id)).toEqual(["r1"]);
    expect(archive.onArchiveEntries).not.toHaveBeenCalled();
  });
});

describe("SquadScreen", () => {
  it("shows buckets, people, holds and inbox load", () => {
    render(
      <SquadScreen
        data={{
          snapshot: {
            generated_at: "2026-11-12T09:07:00Z", window_hours: 24,
            buckets: { people: { hours: 868, share: 0.41 }, working: { hours: 266, share: 0.13 } },
            people: [{ name: "Alfredo", hours: 255.7 }],
            people_via_blocked: [{ key: "CTG-2643", title: "Resolver timing", human: "Alfredo", hours: 60.5, cards: [1, 2, 3, 4] }],
          },
          received_at: "2026-11-12T09:08:00Z",
          inbox_load: [{ user_id: "u", name: "Alfredo", decisions: 11, merges: 9, everything_else: 15, new_asks_7d: 135 }],
        }}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "smart.tabs.buckets.people 41%, smart.tabs.buckets.working 13%");
    expect(screen.getAllByText("Alfredo").length).toBeGreaterThan(1);
    expect(screen.getByText("CTG-2643")).toBeInTheDocument();
    expect(screen.getByText("135")).toBeInTheDocument();
  });

  it("says when there is no data yet", () => {
    render(<SquadScreen data={{ snapshot: null, received_at: null, inbox_load: [] }} />);
    expect(screen.getByText("smart.tabs.squad_empty")).toBeInTheDocument();
  });
});

// Owner 2026-11-12: with nothing selected the content pane is empty; the tabs
// never leave a card open that the user did not pick on the tab in view.
describe("InboxTabsView selection", () => {
  beforeEach(() => localStorage.clear());

  it("selects nothing on its own when it first renders", () => {
    const { onSelect, onClearSelection } = renderTabsWith([signal("decision"), signal("merge")]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it("empties the content pane on a tab switch", () => {
    const ask = signal("decision", {}, { title: "Ask" });
    const { onClearSelection } = renderTabsWith([ask, signal("merge")], ask.id);
    fireEvent.click(tab(/merges/));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("leaves an empty pane alone on a tab switch", () => {
    const ask = signal("decision", {}, { title: "Ask" });
    const empty = renderTabsWith([ask]);
    fireEvent.click(tab(/merges/));
    expect(empty.onClearSelection).not.toHaveBeenCalled();
  });

  it("keeps the card open when the tab in view is clicked again", () => {
    const ask = signal("decision", {}, { title: "Ask" });
    const { onClearSelection } = renderTabsWith([ask], ask.id);
    fireEvent.click(tab(/today/));
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it("closes the open card when its row leaves the tab", () => {
    const ask = signal("decision", {}, { title: "Ask" });
    const other = signal("decision", {}, { title: "Other" });
    const { onClearSelection, rerender } = renderTabsWith([ask, other], ask.id);
    expect(onClearSelection).not.toHaveBeenCalled();
    // The merge ask finished, say: the row is gone from Today but the item is not.
    rerender([other, { ...ask, details: { ...(ask.details as object), group: "fyi" } as InboxItem["details"], severity: "info" }], ask.id);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("keeps a deep-linked card open although the tab in view does not list it", () => {
    const merge = signal("merge", {}, { title: "PR" });
    const { onClearSelection, rerender } = renderTabsWith([signal("decision"), merge], "issue-elsewhere");
    rerender([signal("decision"), merge], "issue-elsewhere");
    expect(onClearSelection).not.toHaveBeenCalled();
  });
});
