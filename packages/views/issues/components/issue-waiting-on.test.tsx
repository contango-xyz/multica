import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { propertyKeys } from "@multica/core/properties";
import type { AgentTask, Issue } from "@multica/core/types";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { BoardCardContent } from "./board-card";
import { IssueWaitingOn } from "./issue-waiting-on";
import { ListRow } from "./list-row";

const mocks = vi.hoisted(() => ({
  listProperties: vi.fn(),
}));

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { listProperties: mocks.listProperties },
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));

vi.mock("@multica/core/issues/stores/view-store-context", () => ({
  useViewStore: (selector: (state: unknown) => unknown) =>
    selector({
      viewMode: "board",
      grouping: "status",
      swimlaneGrouping: "assignee",
      cardProperties: {},
      cardPropertyIds: [],
    }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Someone" }),
}));

vi.mock("../../i18n", () => ({
  useLocale: () => "en",
  useT: () => ({ t: () => "Translated" }),
  useTimeAgo: () => () => "now",
}));

vi.mock("../actions", () => ({
  IssueActionsContextMenu: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./issue-agent-activity-indicator", () => ({
  IssueAgentActivityIndicator: () => null,
}));

vi.mock("./custom-status-chip", () => ({
  CustomStatusChip: () => null,
  useIsCustomStatus: () => false,
}));

const PROPERTY_ID = "prop-waiting-on";
const LINE = "blocked by CTG-1907 (in progress) · since 09:21";

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/issues",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path) => `https://app.example${path}`,
};

function makeIssue(value?: unknown, id = "issue-1") {
  return {
    id,
    identifier: "CTG-1",
    title: "A card",
    status: "todo",
    priority: "none",
    labels: [],
    properties: value === undefined ? {} : { [PROPERTY_ID]: value },
  } as unknown as Issue;
}

function task(status: AgentTask["status"], issueId = "issue-1") {
  return { id: `task-${status}`, agent_id: "agent-1", issue_id: issueId, status } as AgentTask;
}

function makeClient(tasks: AgentTask[] = []) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(propertyKeys.list("ws-1"), {
    properties: [
      { id: "prop-other", name: "Estimate", type: "number" },
      { id: PROPERTY_ID, name: "Waiting on", type: "text" },
    ],
  });
  qc.setQueryData(agentTaskSnapshotOptions("ws-1").queryKey, tasks);
  return qc;
}

function renderWith(qc: QueryClient, ui: ReactNode) {
  return render(
    <QueryClientProvider client={qc}>
      <NavigationProvider value={navigation}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
}

const line = () => document.querySelector('[data-slot="issue-waiting-on"]');

describe("IssueWaitingOn", () => {
  beforeEach(() => mocks.listProperties.mockReset());
  afterEach(cleanup);

  it("shows the property's text", () => {
    renderWith(makeClient(), <IssueWaitingOn issue={makeIssue(LINE)} />);
    expect(screen.getByText(LINE)).toBeTruthy();
  });

  it("finds the property by name, not by position or id", () => {
    const qc = makeClient();
    qc.setQueryData(propertyKeys.list("ws-1"), {
      properties: [{ id: "other-id", name: "Waiting on", type: "text" }],
    });
    const issue = { ...makeIssue(), properties: { "other-id": LINE } } as Issue;
    renderWith(qc, <IssueWaitingOn issue={issue} />);
    expect(screen.getByText(LINE)).toBeTruthy();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not text", 3],
  ])("renders nothing when the value is %s", (_name, value) => {
    const { container } = renderWith(makeClient(), <IssueWaitingOn issue={makeIssue(value)} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the workspace has no such property", () => {
    const qc = makeClient();
    qc.setQueryData(propertyKeys.list("ws-1"), { properties: [] });
    const { container } = renderWith(qc, <IssueWaitingOn issue={makeIssue(LINE)} />);
    expect(container.innerHTML).toBe("");
  });

  it.each(["running", "queued", "dispatched"] as const)(
    "is hidden while the issue has a %s task",
    (status) => {
      renderWith(makeClient([task(status)]), <IssueWaitingOn issue={makeIssue(LINE)} />);
      expect(line()).toBeNull();
    },
  );

  it("ignores another issue's task and a finished task", () => {
    renderWith(
      makeClient([task("running", "issue-2"), task("completed")]),
      <IssueWaitingOn issue={makeIssue(LINE)} />,
    );
    expect(line()).not.toBeNull();
  });

  it("disappears live when an agent starts and comes back when it stops", async () => {
    const qc = makeClient();
    renderWith(qc, <IssueWaitingOn issue={makeIssue(LINE)} />);
    expect(line()).not.toBeNull();

    const key = agentTaskSnapshotOptions("ws-1").queryKey;
    act(() => qc.setQueryData(key, [task("running")]));
    await waitFor(() => expect(line()).toBeNull());

    act(() => qc.setQueryData(key, []));
    await waitFor(() => expect(line()).not.toBeNull());
  });

  it("truncates to one line and keeps the full text on hover", () => {
    renderWith(makeClient(), <IssueWaitingOn issue={makeIssue(LINE)} />);
    expect(line()?.getAttribute("title")).toBe(LINE);
    expect(screen.getByText(LINE).className).toContain("truncate");
    expect(screen.getByText(LINE).className).toContain("min-w-0");
    expect(line()?.className).toContain("min-w-0");
  });

  it("reads as a warning when the line starts with the warning sign", () => {
    const stuck = "⚠ stuck: no run, wait or ask · since 10:00";
    renderWith(makeClient(), <IssueWaitingOn issue={makeIssue(stuck)} />);
    expect(line()?.className).toContain("text-warning");
    expect(line()?.className).not.toContain("text-muted-foreground");
    // The icon replaces the glyph on screen; the hover text is untouched.
    expect(screen.getByText("stuck: no run, wait or ask · since 10:00")).toBeTruthy();
    expect(line()?.getAttribute("title")).toBe(stuck);
    expect(line()?.querySelector("svg")).not.toBeNull();
  });

  it("is muted for an ordinary line", () => {
    renderWith(makeClient(), <IssueWaitingOn issue={makeIssue(LINE)} />);
    expect(line()?.className).toContain("text-muted-foreground");
    expect(line()?.className).not.toContain("text-warning");
  });

  it("fetches the property definitions once however many rows render", async () => {
    mocks.listProperties.mockResolvedValue({
      properties: [{ id: PROPERTY_ID, name: "Waiting on", type: "text" }],
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    qc.setQueryData(agentTaskSnapshotOptions("ws-1").queryKey, []);
    renderWith(
      qc,
      <>
        <ListRow issue={makeIssue(LINE, "issue-1")} />
        <ListRow issue={makeIssue(LINE, "issue-2")} />
        <BoardCardContent issue={makeIssue(LINE, "issue-3")} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText(LINE)).toHaveLength(3));
    expect(mocks.listProperties).toHaveBeenCalledTimes(1);
  });
});

describe("IssueWaitingOn on issue surfaces", () => {
  afterEach(cleanup);

  it("appears on a board card, on one line", () => {
    renderWith(makeClient(), <BoardCardContent issue={makeIssue(LINE)} />);
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(line()?.className).toContain("max-w-full");
  });

  it("appears in a list row without taking the title's room", () => {
    renderWith(makeClient(), <ListRow issue={makeIssue(LINE)} />);
    const row = document.querySelector('[data-slot="issue-list-row"]');
    expect(row?.textContent).toContain(LINE);
    expect(line()?.className).toContain("max-w-[40%]");
  });

  it.each([
    ["board card", (issue: Issue) => <BoardCardContent issue={issue} />],
    ["list row", (issue: Issue) => <ListRow issue={issue} />],
  ])("adds nothing to a %s when the value is empty or an agent runs", (_name, ui) => {
    const empty = renderWith(makeClient(), ui(makeIssue()));
    expect(line()).toBeNull();
    empty.unmount();
    renderWith(makeClient([task("running")]), ui(makeIssue(LINE)));
    expect(line()).toBeNull();
  });
});
