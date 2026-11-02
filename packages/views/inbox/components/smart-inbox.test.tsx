import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@multica/core/types";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

// t(selector) returns the selected key path, e.g. "smart.sections.merge".
function pathProxy(path: string[] = []): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key) => (key === "__path" ? path.join(".") : pathProxy([...path, String(key)])),
    },
  );
}
vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (sel: (p: unknown) => { __path: string }, opts?: { count?: number }) =>
      sel(pathProxy()).__path + (opts?.count !== undefined ? `:${opts.count}` : ""),
  }),
}));
vi.mock("./inbox-list-item", () => ({ useTimeAgo: () => () => "1h" }));
vi.mock("./inbox-detail-label", () => ({ useTypeLabels: () => ({ status_changed: "Status changed" }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let items: InboxItem[] = [];
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: items, isLoading: false }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));
const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn((_id?: string) => Promise.resolve()) });
const markRead = mutation();
const archive = mutation();
const markAllRead = mutation();
const archiveAll = mutation();
const archiveAllRead = mutation();
const archiveCompleted = mutation();
vi.mock("@multica/core/inbox/mutations", () => ({
  useMarkInboxRead: () => markRead,
  useArchiveInbox: () => archive,
  useMarkAllInboxRead: () => markAllRead,
  useArchiveAllInbox: () => archiveAll,
  useArchiveAllReadInbox: () => archiveAllRead,
  useArchiveCompletedInbox: () => archiveCompleted,
}));
vi.mock("@multica/core/inbox/queries", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/inbox/queries")>("@multica/core/inbox/queries");
  return {
    inboxListOptions: () => ({}),
    // The real per-issue grouping, so signal/mention interplay is covered.
    deduplicateInboxItems: actual.deduplicateInboxItems,
    useInboxUnreadCount: () => 2,
  };
});
vi.mock("../../issues/surface/activity", () => ({
  useIssueSurfaceActivity: () => ({ activityByIssueId: new Map() }),
}));
vi.mock("./inbox-filter-menu", () => ({
  InboxFilterMenu: () => <div data-testid="classic-filters" />,
}));
vi.mock("./smart-dashboard", () => ({
  SmartDashboard: ({ compact, sections }: { compact?: boolean; sections: unknown[] }) => (
    <div data-testid="dashboard" data-compact={String(!!compact)} data-sections={sections.length} />
  ),
}));
let compact = false;
vi.mock("@multica/ui/hooks/use-mobile", () => ({ useIsCompact: () => compact }));

import { SmartInboxPage } from "./smart-inbox";

function base(over: Partial<Omit<InboxItem, "details">> & { details?: unknown }): InboxItem {
  return {
    id: "x",
    workspace_id: "ws",
    recipient_type: "member",
    recipient_id: "u",
    actor_type: null,
    actor_id: null,
    type: "status_changed",
    severity: "info",
    issue_id: null,
    title: "t",
    body: null,
    issue_status: null,
    read: false,
    archived: false,
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
    details: (over.details ?? null) as InboxItem["details"],
  };
}

const push = vi.fn();
function renderPage() {
  const nav = { push, replace: vi.fn(), back: vi.fn(), pathname: "/acme/inbox", searchParams: new URLSearchParams(), hash: "" } as unknown as NavigationAdapter;
  return render(
    <NavigationProvider value={nav}>
      <SmartInboxPage />
    </NavigationProvider>,
  );
}

import { useInboxFilterStore } from "@multica/core/inbox/filter-store";
import { useSmartInboxFilterStore } from "@multica/core/inbox/smart-filter-store";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
function sig(id: string, group: string, rank: Record<string, unknown>, over: Partial<Omit<InboxItem, "details">> = {}) {
  return base({
    id,
    type: "signal",
    severity: "action_required",
    title: `Signal ${id}`,
    details: { key: id, group, summary: `why ${id}`, actions: [], rank },
    ...over,
  });
}

describe("SmartInboxPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compact = false;
    useInboxFilterStore.setState({ filtersByWorkspace: {} });
    useSmartInboxFilterStore.setState({ filtersByWorkspace: {} });
    items = [
      base({
        id: "sig",
        type: "signal",
        severity: "action_required",
        title: "Approve merge #3204",
        body: "Context for the merge.",
        issue_id: "issue-1",
        details: {
          key: "k",
          group: "merge",
          summary: "CTG-1718 · blocks 3 cards",
          actions: [{ label: "Open PR", url: "https://github.com/x/pull/1" }],
          rank: { priority: "urgent", blocks: 3, since: hoursAgo(6) },
        },
      }),
      sig("dec", "decision", { priority: "low", since: hoursAgo(1) }),
      base({ id: "mention", type: "mentioned", title: "Login bug", body: "@you can you look?", issue_id: "issue-2" }),
      base({ id: "status", title: "Status moved", issue_id: "issue-3", read: true }),
    ];
  });

  const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

  it("shows one section per group, ordered by the top entry, FYI last, with count and top reason", () => {
    renderPage();
    expect(headings()).toEqual([
      "smart.sections.merge · 1 · smart.priority.urgent · smart.blocks:3 · 1h",
      "smart.sections.decision · 1 · smart.priority.low · 1h",
      "smart.sections.mentions · 1 · 1h",
      "smart.sections.fyi · 1 · 1h",
    ]);
    const merge = screen.getByRole("region", { name: /sections\.merge/ });
    const [row] = within(merge).getAllByRole("listitem");
    expect(row).toHaveTextContent("Approve merge #3204");
    expect(row).toHaveTextContent("CTG-1718 · blocks 3 cards");
    // Existing entries show their comment preview.
    expect(screen.getByRole("region", { name: /sections\.mentions/ })).toHaveTextContent("@you can you look?");
  });

  it("shows the compact dashboard above the sections", () => {
    renderPage();
    expect(screen.getByTestId("dashboard")).toHaveAttribute("data-compact", "true");
    expect(screen.getByTestId("dashboard")).toHaveAttribute("data-sections", "4");
  });

  it("keeps Classic's filters and bulk actions in the header", () => {
    renderPage();
    expect(screen.getByTestId("classic-filters")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "smart.bulk_menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "menu.archive_all_read" }));
    expect(archiveAllRead.mutate).toHaveBeenCalled();
  });

  it("applies the classic unread filter and the smart group / needs-you filters", () => {
    useInboxFilterStore.getState().toggleUnreadOnly("ws");
    const { unmount } = renderPage();
    expect(headings().map((h) => h!.split(" ·")[0])).toEqual([
      "smart.sections.merge",
      "smart.sections.decision",
      "smart.sections.mentions",
    ]);
    unmount();
    useInboxFilterStore.getState().clearFilters("ws");
    useSmartInboxFilterStore.getState().toggleGroup("ws", "decision");
    useSmartInboxFilterStore.getState().toggleGroup("ws", "fyi");
    const second = renderPage();
    expect(headings().map((h) => h!.split(" ·")[0])).toEqual(["smart.sections.decision", "smart.sections.fyi"]);
    second.unmount();
    useSmartInboxFilterStore.getState().clearSmartFilters("ws");
    useSmartInboxFilterStore.getState().toggleNeedsYouOnly("ws");
    renderPage();
    expect(headings().map((h) => h!.split(" ·")[0])).toEqual([
      "smart.sections.merge",
      "smart.sections.decision",
      "smart.sections.mentions",
    ]);
  });

  it("archives or marks read a whole section from its header", async () => {
    items.push(sig("dec2", "decision", { priority: "low", since: hoursAgo(0.5) }, { read: true }));
    renderPage();
    const decision = screen.getByRole("region", { name: /sections\.decision/ });
    fireEvent.click(within(decision).getByRole("button", { name: "smart.section_actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "smart.mark_section_read" }));
    expect(markRead.mutateAsync.mock.calls.map((c) => c[0])).toEqual(["dec"]);
    fireEvent.click(within(decision).getByRole("button", { name: "smart.section_actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "smart.archive_section" }));
    expect(archive.mutateAsync.mock.calls.map((c) => c[0]).sort()).toEqual(["dec", "dec2"]);
  });

  it("shows one row per card: the mention folds into the card's signal and opening it reads both", () => {
    items = [
      base({ id: "m", type: "mentioned", title: "Tagged", body: "@you approve?", issue_id: "issue-9", actor_type: "agent", actor_id: "brooks", created_at: hoursAgo(2) }),
      sig("s", "merge", { priority: "high", since: hoursAgo(2) }, { issue_id: "issue-9", created_at: hoursAgo(0.1), read: true }),
    ];
    renderPage();
    const merge = screen.getByRole("region", { name: /sections\.merge/ });
    expect(within(merge).getByRole("listitem")).toHaveTextContent("Signal s");
    expect(screen.queryByRole("region", { name: /sections\.mentions/ })).toBeNull();
    fireEvent.click(within(merge).getByRole("button", { name: /Signal s/ }));
    expect(markRead.mutate.mock.calls.map((c) => c[0])).toEqual(["m"]);
  });

  it("archives a single row", () => {
    renderPage();
    const fyi = screen.getByRole("region", { name: /sections\.fyi/ });
    fireEvent.click(within(fyi).getByRole("button", { name: "list.archive_tooltip" }));
    expect(archive.mutate).toHaveBeenCalledWith("status", expect.anything());
  });

  it("on phones, folds sections and previews the top 3 with 'Show N more'", () => {
    compact = true;
    for (let i = 0; i < 4; i++) items.push(sig(`m${i}`, "merge", { priority: "low", since: hoursAgo(1) }));
    renderPage();
    const merge = screen.getByRole("region", { name: /sections\.merge/ });
    expect(within(merge).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(merge).getByRole("button", { name: "smart.show_more:2" }));
    expect(within(merge).getAllByRole("listitem")).toHaveLength(5);
    const toggle = within(merge).getByRole("button", { expanded: true });
    fireEvent.click(toggle);
    expect(within(merge).queryAllByRole("listitem")).toHaveLength(0);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("gives each row one primary action: the signal's link, else open the issue", () => {
    renderPage();
    // Base UI keeps role="button" on the rendered anchor.
    const link = screen.getByRole("button", { name: "Open PR" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://github.com/x/pull/1");
    expect(link).toHaveAttribute("target", "_blank");
    const mentions = screen.getByRole("region", { name: /sections\.mentions/ });
    fireEvent.click(within(mentions).getByRole("button", { name: "smart.open" }));
    expect(push).toHaveBeenCalledWith("/acme/issues/issue-2");
  });

  it("opens a focused detail instead of the thread, and marks it read", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Approve merge #3204/ }));
    expect(markRead.mutate).toHaveBeenCalledWith("sig");
    expect(screen.getByRole("heading", { level: 1, name: "Approve merge #3204" })).toBeInTheDocument();
    expect(screen.getByText("Context for the merge.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "smart.open_issue" }));
    expect(push).toHaveBeenCalledWith("/acme/issues/issue-1");
    fireEvent.click(screen.getByRole("button", { name: "detail.archive" }));
    expect(archive.mutate).toHaveBeenCalledWith("sig", expect.anything());
  });

  it("uses 44px tap targets for rows on phones", () => {
    compact = true;
    renderPage();
    for (const region of screen.getAllByRole("region")) {
      for (const li of within(region).getAllByRole("listitem")) {
        expect(li.querySelector("button")!.className).toContain("min-h-11");
      }
    }
  });
});
