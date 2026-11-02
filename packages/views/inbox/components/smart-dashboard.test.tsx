import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSmartSections } from "@multica/core/inbox/smart";
import { useSmartInboxFilterStore } from "@multica/core/inbox/smart-filter-store";
import type { InboxItem } from "@multica/core/types";

// t(selector, opts) -> "path" or "path:count/age".
vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (sel: (p: unknown) => unknown, opts?: { count?: number; age?: string }) => {
      const path: string[] = [];
      const proxy: unknown = new Proxy({}, { get: (_t, k) => { path.push(String(k)); return proxy; } });
      sel(proxy);
      const arg = opts?.age ?? opts?.count;
      return path.join(".") + (arg !== undefined ? `:${arg}` : "");
    },
  }),
}));

import { SmartDashboard } from "./smart-dashboard";

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
let seq = 0;
function signal(group: string, rank: Record<string, unknown>, over: Partial<InboxItem> = {}): InboxItem {
  seq += 1;
  return {
    id: `s${seq}`, workspace_id: "ws", recipient_type: "member", recipient_id: "u", actor_type: "system", actor_id: null,
    type: "signal", severity: "action_required", issue_id: null, title: `Signal ${seq}`, body: null, issue_status: null,
    read: false, archived: false, created_at: hoursAgo(0.5),
    details: { key: `k${seq}`, group, summary: "why", actions: [], rank } as unknown as InboxItem["details"],
    ...over,
  };
}

function renderDashboard(items: InboxItem[], compact = false) {
  const onSelect = vi.fn();
  render(<SmartDashboard wsId="ws" sections={buildSmartSections(items, NOW)} onSelect={onSelect} compact={compact} />);
  return onSelect;
}

describe("SmartDashboard", () => {
  beforeEach(() => useSmartInboxFilterStore.setState({ filtersByWorkspace: {} }));

  it("numbers the top 3 by rank with their action and a plain reason", () => {
    renderDashboard([
      signal("decision", { priority: "high", since: hoursAgo(10) }, { title: "Decide" }),
      signal("merge", { priority: "urgent", blocks: 4, since: hoursAgo(9) }, {
        title: "Approve merge",
        details: { key: "m", group: "merge", summary: "", actions: [{ label: "Open PR", url: "https://x.test/pr" }], rank: { priority: "urgent", blocks: 4, since: hoursAgo(9) } } as unknown as InboxItem["details"],
      }),
      signal("access", { priority: "medium", blocks: 1, since: hoursAgo(5) }, { title: "Grant access" }),
      signal("stalled", { priority: "low", since: hoursAgo(1) }, { title: "Fourth" }),
    ]);
    const items = within(screen.getByRole("region", { name: /do_first/ })).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("button")!.textContent)).toEqual(["1. Approve merge", "2. Decide", "3. Grant access"]);
    expect(items[0]).toHaveTextContent("smart.priority.urgent");
    expect(items[0]).toHaveTextContent("smart.dashboard.blocks_cards:4");
    expect(items[0]).toHaveTextContent("smart.dashboard.waiting_for:list.time.hours:9");
    expect(within(items[0]!).getByRole("button", { name: /Open PR/ })).toHaveAttribute("href", "https://x.test/pr");
  });

  it("says nothing is waiting instead of looking empty", () => {
    renderDashboard([signal("fyi", {}, { severity: "info" })]);
    expect(screen.getByText("smart.dashboard.nothing_waiting")).toBeInTheDocument();
  });

  it("counters filter the list below", () => {
    renderDashboard([
      signal("merge", { priority: "urgent", since: hoursAgo(30) }),
      signal("merge", { priority: "high", since: hoursAgo(2) }),
      signal("decision", { priority: "low", since: hoursAgo(1) }),
    ]);
    const counters = screen.getByRole("group", { name: "smart.dashboard.dashboard" });
    expect(within(counters).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "smart.dashboard.waiting:3",
      "smart.sections.merge · 2",
      "smart.sections.decision · 1",
      "smart.dashboard.oldest:list.time.days:1",
      "smart.dashboard.urgent:1",
    ]);
    fireEvent.click(within(counters).getByRole("button", { name: "smart.sections.merge · 2" }));
    expect(useSmartInboxFilterStore.getState().filtersByWorkspace.ws!.groups).toEqual(["merge"]);
    fireEvent.click(within(counters).getByRole("button", { name: "smart.dashboard.urgent:1" }));
    expect(useSmartInboxFilterStore.getState().filtersByWorkspace.ws!.urgentOnly).toBe(true);
    fireEvent.click(within(counters).getByRole("button", { name: "smart.dashboard.waiting:3" }));
    expect(useSmartInboxFilterStore.getState().filtersByWorkspace.ws!.needsYouOnly).toBe(true);
  });

  it("shows squad health only from the reader's stalled, blocking and alert signals", () => {
    const onSelect = renderDashboard([
      signal("alert", {}, { severity: "attention", title: "main red" }),
      signal("stalled", {}, { severity: "attention" }),
    ]);
    const health = screen.getByRole("group", { name: "smart.dashboard.health" });
    expect(within(health).getAllByRole("button").map((b) => b.textContent)).toEqual(["main red", "smart.dashboard.stalled:1"]);
    fireEvent.click(within(health).getByRole("button", { name: "main red" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ title: "main red" }));
  });

  it("has no health line when there is nothing to report", () => {
    renderDashboard([signal("merge", {})]);
    expect(screen.queryByRole("group", { name: "smart.dashboard.health" })).toBeNull();
  });

  it("on phones shows only Do this first and one counters line", () => {
    renderDashboard([signal("merge", { priority: "urgent", since: hoursAgo(5) }), signal("stalled", {}, { severity: "attention" })], true);
    expect(screen.getByRole("region", { name: /do_first/ })).toBeInTheDocument();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: /smart\.dashboard\.waiting:1 · smart\.dashboard\.oldest:list\.time\.hours:5 · smart\.dashboard\.urgent:1/ })).toBeInTheDocument();
  });
});
