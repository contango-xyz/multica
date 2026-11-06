// @vitest-environment jsdom

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import type { MvpAsk, MvpIssue, MvpReport } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => buildIssueStatusCatalog(undefined),
}));
const auth = vi.hoisted(() => ({ userId: "u1" }));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: auth.userId } }),
}));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_t: string, id: string) => `Name ${id}` }),
}));
vi.mock("@tanstack/react-query", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="avatar">{actorId}</span>,
}));
vi.mock("../../editor/readonly-content", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <div data-testid="definition">{content}</div>,
}));
vi.mock("../../inbox/components/signal-reply-button", () => ({
  SignalReplyButton: ({ item, reply }: { item: { id: string }; reply: { label: string } }) => (
    <button type="button" data-item={item.id}>
      {reply.label}
    </button>
  ),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { IssueLine, MvpBody } from "./mvp-page";

afterEach(cleanup);

function issue(n: number, over: Partial<MvpIssue> = {}): MvpIssue {
  return {
    id: `i${n}`, identifier: `CTG-${n}`, number: n, title: `Card ${n}`, status: "todo", priority: "none",
    assignee_type: null, assignee_id: null, responsible_id: null, parent_id: null, blocked_by: [], blocks: 0,
    on_critical_path: false, last_run_at: null, flags: [], ...over,
  };
}

function ask(n: number, over: Partial<MvpAsk> = {}): MvpAsk {
  return {
    issue: issue(n), comment_id: `c${n}`, kind: "human", excerpt: `Ask ${n}`, created_at: new Date().toISOString(),
    recipient_id: "u1", blocks: 0, inbox_item_id: null, replies: [], ...over,
  };
}

const counts = { total: 0, open: 0, done: 0, cancelled: 0, by_status: {} };

function report(over: Partial<MvpReport> = {}): MvpReport {
  return {
    configured: true, problem: null,
    config: { home_issue: "CTG-9", release_property: "Release", release_option: "MVP", idle_hours: 24, days: 30 },
    generated_at: null,
    home: { id: "h", identifier: "CTG-9", title: "MVP", status: "todo", description: "Ship the **app**" },
    totals: { total: 4, open: 3, done: 1, cancelled: 0, by_status: { todo: 3 } },
    pillars: [
      { issue: issue(10, { title: "Accounts" }), total: 3, open: 2, done: 1, cancelled: 0, by_status: { todo: 2 }, open_items: [issue(2, { blocked_by: [{ id: "i1", identifier: "CTG-1", status: "todo" }] }), issue(3)] },
      { issue: issue(11, { title: "Finished epic" }), total: 1, open: 0, done: 1, cancelled: 0, by_status: {}, open_items: [] },
    ],
    standalone: { ...counts, open_items: [] },
    critical_paths: [{ issues: [issue(1, { on_critical_path: true }), issue(2, { on_critical_path: true })] }],
    burndown: [
      { date: "2026-11-05", open: 4, done: 0 },
      { date: "2026-11-06", open: 3, done: 1 },
    ],
    eta: { open: 3, done_7d: 1, done_14d: 1, rate_7d: 0.14, rate_14d: 0.07, eta_7d: "2026-11-27", eta_14d: null, days_7d: 21, days_14d: null },
    humans: [
      { recipient_id: "u1", cards_blocked: 3, asks: [ask(4, { inbox_item_id: "x1", replies: [{ index: 0, label: "Approve: ok", content: "ok" }] })] },
      { recipient_id: "u2", cards_blocked: 1, asks: [ask(5, { recipient_id: "u2", inbox_item_id: "x2", replies: [{ index: 0, label: "Approve: no", content: "no" }] })] },
    ],
    stuck: { held: [issue(6, { status: "held" })], blocked_no_blocker: [], idle: [] },
    agent_questions: [ask(9, { kind: "operator", excerpt: "Which chains first?" })],
    ...over,
  };
}

describe("MvpBody", () => {
  it("shows the definition with a link to discuss it on the home card", () => {
    renderWithI18n(<MvpBody report={report()} />);
    expect(screen.getByTestId("definition").textContent).toBe("Ship the **app**");
    expect(screen.getByText(/CTG-9 · Edit \/ discuss/).closest("a")?.getAttribute("href")).toBe("/acme/issues/h");
  });

  it("shows the headline numbers and labels the finish date as a projection", () => {
    renderWithI18n(<MvpBody report={report()} />);
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("1 of 4 cards")).toBeTruthy();
    expect(screen.getAllByText(/Projection/).length).toBeGreaterThan(0);
    expect(screen.getByText("At the last 7 days' pace: 2026-11-27 (21 days)")).toBeTruthy();
  });

  it("lists the critical path in order and marks its cards elsewhere", () => {
    renderWithI18n(<MvpBody report={report()} />);
    const chain = screen.getByText(/Chain 1/).parentElement!;
    const keys = within(chain).getAllByText(/^CTG-\d+$/).map((e) => e.textContent);
    expect(keys).toEqual(["CTG-1", "CTG-2"]);
    // Expand the pillar: CTG-2 is highlighted there too, and its blocker chip is critical.
    fireEvent.click(screen.getByText("Accounts"));
    const rows = screen.getAllByText("Card 2").map((e) => e.closest("[data-critical]"));
    expect(rows.length).toBe(2);
    expect(rows.every(Boolean)).toBe(true);
  });

  it("groups asks by human and offers one-tap replies only to their recipient", () => {
    renderWithI18n(<MvpBody report={report()} />);
    expect(screen.getByText("Name u1")).toBeTruthy();
    expect(screen.getByText(/Holds 3 MVP cards/)).toBeTruthy();
    expect(screen.getByText("Approve: ok").getAttribute("data-item")).toBe("x1");
    expect(screen.queryByText("Approve: no")).toBeNull();
    expect(screen.getByText("Ask 4").closest("a")?.getAttribute("href")).toBe("/acme/issues/i4#comment-c4");
  });

  it("counts held, blocked-without-blocker and idle cards", () => {
    renderWithI18n(<MvpBody report={report()} />);
    const held = screen.getByText("Held").closest("button")!;
    expect(held.textContent).toContain("1");
    fireEvent.click(held);
    expect(screen.getByText("Card 6")).toBeTruthy();
    expect(screen.getByText("No run for 24h+")).toBeTruthy();
  });

  it("surfaces agent questions with a link into the thread", () => {
    renderWithI18n(<MvpBody report={report()} />);
    expect(screen.getByText("Needs operator")).toBeTruthy();
    expect(screen.getByText("Which chains first?").closest("a")?.getAttribute("href")).toBe("/acme/issues/i9#comment-c9");
  });

  it("folds finished pillars away", () => {
    renderWithI18n(<MvpBody report={report()} />);
    expect(screen.queryByText("Finished epic")).toBeNull();
    fireEvent.click(screen.getByText("1 finished pillar"));
    expect(screen.getByText("Finished epic")).toBeTruthy();
  });

  it("says what is missing when the workspace is not set up", () => {
    renderWithI18n(<MvpBody report={report({ configured: false, problem: 'no select property named "Release"', home: null })} />);
    expect(screen.getByText('MVP scope is not set up: no select property named "Release"')).toBeTruthy();
    expect(screen.getByText("No MVP definition card is set.")).toBeTruthy();
  });
});

describe("IssueLine", () => {
  it("shows blockers as links", () => {
    renderWithI18n(<IssueLine issue={issue(2, { blocked_by: [{ id: "i1", identifier: "CTG-1", status: "todo" }] })} critical={new Set()} />);
    expect(screen.getByText("CTG-1").closest("a")?.getAttribute("href")).toBe("/acme/issues/i1");
  });
});
