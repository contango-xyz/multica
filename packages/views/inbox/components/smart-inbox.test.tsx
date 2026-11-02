import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@multica/core/types";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

// t(selector) returns the selected key path, e.g. "smart.sections.waiting".
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
const markRead = vi.fn();
const archive = vi.fn();
vi.mock("@multica/core/inbox/mutations", () => ({
  useMarkInboxRead: () => ({ mutate: markRead }),
  useArchiveInbox: () => ({ mutate: archive }),
}));
vi.mock("@multica/core/inbox/queries", () => ({
  inboxListOptions: () => ({}),
  deduplicateInboxItems: (list: InboxItem[]) => list.filter((i) => !i.archived),
}));

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

describe("SmartInboxPage", () => {
  beforeEach(() => {
    push.mockClear();
    markRead.mockClear();
    archive.mockClear();
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
          rank: { priority: "urgent", blocks: 3, since: new Date(Date.now() - 6 * 3_600_000).toISOString() },
        },
      }),
      base({ id: "mention", type: "mentioned", title: "Login bug", body: "@you can you look?", issue_id: "issue-2" }),
      base({ id: "status", title: "Status moved", issue_id: "issue-3" }),
    ];
  });

  it("puts waiting entries first with the reason, FYI last", () => {
    renderPage();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["smart.sections.waiting · 2", "smart.sections.fyi · 1"]);
    const waiting = screen.getByRole("region", { name: /waiting/ });
    const rows = within(waiting).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Approve merge #3204");
    expect(rows[0]).toHaveTextContent("CTG-1718 · blocks 3 cards");
    expect(rows[0]).toHaveTextContent("smart.priority.urgent · smart.blocks:3 · 1h");
    // Existing entries show their comment preview as line 2.
    expect(rows[1]).toHaveTextContent("@you can you look?");
  });

  it("gives each row one primary action: the signal's link, else open the issue", () => {
    renderPage();
    // Base UI keeps role="button" on the rendered anchor.
    const link = screen.getByRole("button", { name: "Open PR" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://github.com/x/pull/1");
    expect(link).toHaveAttribute("target", "_blank");
    fireEvent.click(screen.getAllByRole("button", { name: "smart.open" })[0]!);
    expect(push).toHaveBeenCalledWith("/acme/issues/issue-2");
  });

  it("opens a focused detail instead of the thread, and marks it read", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Approve merge #3204/ }));
    expect(markRead).toHaveBeenCalledWith("sig");
    expect(screen.getByRole("heading", { level: 1, name: "Approve merge #3204" })).toBeInTheDocument();
    expect(screen.getByText("Context for the merge.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "smart.open_issue" }));
    expect(push).toHaveBeenCalledWith("/acme/issues/issue-1");
    fireEvent.click(screen.getByRole("button", { name: "detail.archive" }));
    expect(archive).toHaveBeenCalledWith("sig", expect.anything());
  });

  it("uses 44px tap targets", () => {
    renderPage();
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("min-h-11");
    }
  });
});
