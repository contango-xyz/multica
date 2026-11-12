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
  InboxListItem: ({ item, onClick }: { item: InboxItem; onClick: () => void }) => (
    <button type="button" data-testid="else-row" onClick={onClick}>{item.title}</button>
  ),
}));
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

function renderTabs(items: InboxItem[]) {
  const onSelect = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InboxTabsView wsId="ws" items={items} now={NOW} selectedKey="" onSelect={onSelect} onArchive={vi.fn()} />
    </QueryClientProvider>,
  );
  return onSelect;
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });

describe("InboxTabsView", () => {
  beforeEach(() => localStorage.clear());

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

  it("Everything else lists the rest and remembers the tab", () => {
    renderTabs([signal("fyi", {}, { severity: "info", title: "FYI one" })]);
    fireEvent.click(tab(/else/));
    expect(within(screen.getByRole("tabpanel")).getByTestId("else-row")).toHaveTextContent("FYI one");
    expect(localStorage.getItem("multica:inbox-tab")).toBe("else");
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
