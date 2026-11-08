import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import {
  pausedWakeupsOptions,
  workspaceWakeupSummariesOptions,
} from "@multica/core/issues/wakeups";
import { propertyKeys } from "@multica/core/properties";
import type { AgentTask, Issue, IssueWakeupSummaryRow, PausedWakeup } from "@multica/core/types";
import en from "../../locales/en/issues.json";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { BoardCardContent } from "./board-card";
import { IssueAgentActivityIndicator } from "./issue-agent-activity-indicator";
import { ListRow } from "./list-row";

const mocks = vi.hoisted(() => ({
  listProperties: vi.fn(),
  listIssueWakeupSummaries: vi.fn(),
}));

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    listProperties: mocks.listProperties,
    listIssueWakeupSummaries: mocks.listIssueWakeupSummaries,
  },
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
  useT: () => ({
    t: (selector: (strings: typeof en) => string, params: Record<string, unknown> = {}) =>
      String(selector(en)).replace(/{{(\w+)}}/g, (_, key: string) => String(params[key] ?? "")),
  }),
  useTimeAgo: () => () => "now",
}));

vi.mock("../actions", () => ({
  IssueActionsContextMenu: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./custom-status-chip", () => ({
  CustomStatusChip: () => null,
  useIsCustomStatus: () => false,
}));

vi.mock("./wakeup-condition-names", () => ({
  useConditionNames: () => ({
    status: (key: string) => key,
    label: () => undefined,
    property: () => undefined,
    actor: (_type: string, id: string) => id,
  }),
}));

vi.mock("../../common/use-viewing-timezone", () => ({
  useViewingTimezone: () => "UTC",
}));

vi.mock("../../agents/components/agent-avatar-stack", () => ({
  AgentAvatarStack: () => <div data-testid="agent-avatar-stack" />,
}));

const PROPERTY_ID = "prop-waiting-on";
const LINE = "blocked by CTG-1907 (in progress) · since 09:21";
const WAKE_LABEL = "Waiting for a run to end";
const propertiesKey = propertyKeys.list("ws-1");
const tasksKey = agentTaskSnapshotOptions("ws-1").queryKey;
const wakeupsKey = workspaceWakeupSummariesOptions("ws-1").queryKey;
const pausedKey = pausedWakeupsOptions("ws-1").queryKey;

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/issues",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path) => `https://app.example${path}`,
};

const wakeup = {
  id: "wake-1",
  issue_id: "issue-1",
  agent_id: "agent-1",
  agent_name: "Emacs",
  kind: "event",
  mode: "continuous",
  event_types: ["task.completed"],
  timezone: "UTC",
  next_fire_at: null,
  active_count: 1,
  event_count: 1,
} as unknown as IssueWakeupSummaryRow;

const pausedWakeup = {
  issue_id: "issue-1",
  id: "wake-2",
  agent_id: "agent-1",
  paused_reason: "rate_limited",
} as unknown as PausedWakeup;

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
  return {
    id: `task-${status}`,
    agent_id: "agent-1",
    issue_id: issueId,
    status,
    created_at: "2026-11-08T08:00:00Z",
  } as AgentTask;
}

const definitions = {
  properties: [
    { id: "prop-other", name: "Estimate", type: "number" },
    { id: PROPERTY_ID, name: "Waiting on", type: "text" },
  ],
};

function makeClient({
  tasks = [],
  wakeups = [],
  paused = [],
}: { tasks?: AgentTask[]; wakeups?: IssueWakeupSummaryRow[]; paused?: PausedWakeup[] } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(propertiesKey, definitions);
  qc.setQueryData(tasksKey, tasks);
  qc.setQueryData(wakeupsKey, wakeups);
  qc.setQueryData(pausedKey, paused);
  return qc;
}

function renderWith(qc: QueryClient, ui: ReactNode) {
  return render(
    <QueryClientProvider client={qc}>
      <NavigationProvider value={navigation}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
}

function indicator(value?: unknown) {
  return <IssueAgentActivityIndicator issueId="issue-1" waitingOnProperties={makeIssue(value).properties} />;
}

const line = () => document.querySelector('[data-slot="issue-waiting-on"]');
const lines = () => document.querySelectorAll('[data-slot="issue-waiting-on"]');
const propertyObservers = (qc: QueryClient) =>
  qc.getQueryCache().find({ queryKey: propertiesKey })?.getObserversCount();

beforeEach(() => {
  mocks.listProperties.mockReset();
  mocks.listIssueWakeupSummaries.mockReset();
});
afterEach(cleanup);

describe("Waiting on, as the activity indicator's last fallback", () => {
  it("shows when no task, wakeup or paused wakeup exists", () => {
    renderWith(makeClient(), indicator(LINE));
    expect(screen.getByText(LINE)).toBeTruthy();
  });

  it("finds the property by name, not by id", () => {
    const qc = makeClient();
    qc.setQueryData(propertiesKey, {
      properties: [{ id: "other-id", name: "Waiting on", type: "text" }],
    });
    renderWith(
      qc,
      <IssueAgentActivityIndicator issueId="issue-1" waitingOnProperties={{ "other-id": LINE }} />,
    );
    expect(screen.getByText(LINE)).toBeTruthy();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not text", 3],
  ])("renders nothing when the value is %s", (_name, value) => {
    renderWith(makeClient(), indicator(value));
    expect(line()).toBeNull();
  });

  it.each(["running", "queued", "dispatched"] as const)(
    "is hidden while the issue has a %s task",
    (status) => {
      renderWith(makeClient({ tasks: [task(status)] }), indicator(LINE));
      expect(line()).toBeNull();
      expect(screen.getByTestId("agent-avatar-stack")).toBeTruthy();
    },
  );

  it("is hidden by a future wakeup, which keeps its own label", () => {
    renderWith(makeClient({ wakeups: [wakeup] }), indicator(LINE));
    expect(line()).toBeNull();
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.getByText(WAKE_LABEL)).toBeTruthy();
  });

  it("is hidden by a paused wakeup, which keeps its own label", () => {
    renderWith(makeClient({ paused: [pausedWakeup] }), indicator(LINE));
    expect(line()).toBeNull();
    expect(screen.getByText(en.wakeups.wait.paused)).toBeTruthy();
  });

  it("ignores another issue's task and wakeups, and a finished task", () => {
    renderWith(
      makeClient({
        tasks: [task("running", "issue-2"), task("completed")],
        wakeups: [{ ...wakeup, issue_id: "issue-2" }],
        paused: [{ ...pausedWakeup, issue_id: "issue-2" }],
      }),
      indicator(LINE),
    );
    expect(line()).not.toBeNull();
  });

  it("waits for the wakeups to load, so it never flashes before one", async () => {
    let resolve: (rows: unknown[]) => void = () => undefined;
    mocks.listIssueWakeupSummaries.mockReturnValue(new Promise((r) => (resolve = r)));
    const qc = makeClient();
    qc.removeQueries({ queryKey: wakeupsKey });
    renderWith(qc, indicator(LINE));
    expect(line()).toBeNull();
    await act(async () => resolve([]));
    await waitFor(() => expect(line()).not.toBeNull());
  });

  it("goes away live when an agent starts and comes back when it stops", async () => {
    const qc = makeClient();
    renderWith(qc, indicator(LINE));
    expect(line()).not.toBeNull();

    act(() => qc.setQueryData(tasksKey, [task("running")]));
    await waitFor(() => expect(line()).toBeNull());

    act(() => qc.setQueryData(tasksKey, []));
    await waitFor(() => expect(line()).not.toBeNull());
  });

  it("is not shown without the prop, as on Inbox rows", () => {
    const qc = makeClient();
    const { container } = renderWith(qc, <IssueAgentActivityIndicator issueId="issue-1" />);
    expect(container.innerHTML).toBe("");
    expect(propertyObservers(qc)).toBe(0);
  });

  it("does not subscribe a row with no property values", () => {
    const qc = makeClient();
    renderWith(qc, indicator());
    expect(propertyObservers(qc)).toBe(0);
  });

  it("truncates like the wake label and keeps the full text on hover", () => {
    renderWith(makeClient(), indicator(LINE));
    expect(line()?.getAttribute("title")).toBe(LINE);
    expect(line()?.className).toContain("shrink-0");
    const text = screen.getByText(LINE);
    expect(text.className).toContain("truncate");
    expect(text.className).toContain("max-w-36");
    expect(text.className).toContain("text-micro");
  });

  it("reads as a warning when the line starts with the warning sign", () => {
    const stuck = "⚠ stuck: no run, wait or ask · since 10:00";
    renderWith(makeClient(), indicator(stuck));
    const text = screen.getByText("stuck: no run, wait or ask · since 10:00");
    expect(text.className).toContain("text-warning");
    expect(text.className).not.toContain("text-muted-foreground");
    expect(line()?.querySelector("svg")?.getAttribute("class")).toContain("text-warning");
    // The icon replaces the glyph on screen; the hover text is untouched.
    expect(line()?.getAttribute("title")).toBe(stuck);
  });

  it("is muted for an ordinary line", () => {
    renderWith(makeClient(), indicator(LINE));
    const text = screen.getByText(LINE);
    expect(text.className).toContain("text-muted-foreground");
    expect(text.className).not.toContain("text-warning");
    expect(line()?.querySelector("svg")?.getAttribute("class")).toContain("text-muted-foreground");
  });
});

describe("Waiting on, on issue surfaces", () => {
  const before = (a: Element, b: Element) =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("renders once in a list row, in the indicator slot before the title", () => {
    renderWith(makeClient(), <ListRow issue={makeIssue(LINE)} />);
    expect(lines()).toHaveLength(1);
    const title = screen.getByText("A card");
    expect(before(line()!, title)).toBe(true);
    // The title's span also holds the labels and property chips.
    expect(title.parentElement?.contains(line())).toBe(false);
    expect(before(screen.getByText("CTG-1"), line()!)).toBe(true);
  });

  it("renders once on a board card, in the top row with the indicator", () => {
    renderWith(makeClient(), <BoardCardContent issue={makeIssue(LINE)} />);
    expect(lines()).toHaveLength(1);
    expect(line()?.parentElement?.contains(screen.getByText("CTG-1"))).toBe(true);
    expect(before(line()!, screen.getByText("A card"))).toBe(true);
  });

  it.each([
    ["board card", (issue: Issue) => <BoardCardContent issue={issue} />],
    ["list row", (issue: Issue) => <ListRow issue={issue} />],
  ])("gives way to a wakeup on a %s", (_name, ui) => {
    renderWith(makeClient({ wakeups: [wakeup] }), ui(makeIssue(LINE)));
    expect(line()).toBeNull();
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.getByText(WAKE_LABEL)).toBeTruthy();
  });

  it.each([
    ["board card", (issue: Issue) => <BoardCardContent issue={issue} />],
    ["list row", (issue: Issue) => <ListRow issue={issue} />],
  ])("adds nothing to a %s when the value is empty", (_name, ui) => {
    renderWith(makeClient(), ui(makeIssue()));
    expect(line()).toBeNull();
  });

  it("fetches the property definitions once however many rows render", async () => {
    mocks.listProperties.mockResolvedValue(definitions);
    const qc = makeClient();
    qc.removeQueries({ queryKey: propertiesKey });
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
