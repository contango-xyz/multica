import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { pausedWakeupsOptions, workspaceWakeupSummariesOptions } from "@multica/core/issues/wakeups";
import { propertyKeys } from "@multica/core/properties";
import type { IssueWakeup, IssueWakeupSummaryRow } from "@multica/core/types";
import en from "../../locales/en/issues.json";
import { AppLink, NavigationProvider, type NavigationAdapter } from "../../navigation";
import { IssueAgentActivityIndicator } from "./issue-agent-activity-indicator";
import { IssueWakeupHeaderChip } from "./issue-wakeup-header-chip";
import { IssueWaitingOn } from "./issue-waiting-on";
import { splitIssueKeys } from "./wait-issue-links";
import { WakeupsSection } from "./wakeups-section";

const mockRules = vi.hoisted(() => ({ rules: [] as unknown[], system: [] as unknown[] }));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
  useCurrentWorkspace: () => ({ id: "ws-1", issue_prefix: "CTG" }),
}));
vi.mock("@multica/core/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/issues")>()),
  issueWakeupsOptions: () => ({ queryKey: ["chip-rules"], queryFn: () => mockRules.rules }),
  issueSystemWakeupsOptions: () => ({ queryKey: ["chip-system"], queryFn: () => mockRules.system }),
  issueTasksOptions: () => ({ queryKey: ["chip-tasks"], queryFn: () => [] }),
}));
vi.mock("../../i18n", () => ({
  useLocale: () => "en",
  useT: () => ({
    t: (selector: (strings: typeof en) => string, params: Record<string, unknown> = {}) =>
      String(selector(en)).replace(/{{(\w+)}}/g, (_, key: string) => String(params[key] ?? "")),
  }),
}));
vi.mock("./wakeup-condition-names", () => ({
  useConditionNames: () => ({ status: (k: string) => k, label: () => undefined, property: () => undefined, actor: (_t: string, id: string) => id }),
}));
vi.mock("../../common/use-viewing-timezone", () => ({ useViewingTimezone: () => "UTC" }));
vi.mock("../../agents/components/agent-avatar-stack", () => ({ AgentAvatarStack: () => null }));

const push = vi.fn();
const navigation: NavigationAdapter = {
  push,
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/issues",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path) => `https://app.example${path}`,
};

const PROPERTY_ID = "prop-waiting-on";
const propertiesKey = propertyKeys.list("ws-1");

const waitingRow = {
  id: "wake-1",
  issue_id: "issue-1",
  agent_id: "agent-1",
  agent_name: "Emacs",
  kind: "event",
  mode: "once",
  event_types: [],
  timezone: "UTC",
  next_fire_at: null,
  active_count: 1,
  event_count: 1,
  condition: { type: "other_issue", issue_id: "uuid-2421", state: "done", identifier: "CTG-2421" },
} as unknown as IssueWakeupSummaryRow;

function client(wakeups: IssueWakeupSummaryRow[] = [waitingRow]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(agentTaskSnapshotOptions("ws-1").queryKey, []);
  qc.setQueryData(workspaceWakeupSummariesOptions("ws-1").queryKey, wakeups);
  qc.setQueryData(pausedWakeupsOptions("ws-1").queryKey, []);
  qc.setQueryData(propertiesKey, { properties: [{ id: PROPERTY_ID, name: "Waiting on", type: "text" }] });
  return qc;
}

function renderUi(ui: ReactNode, qc = client()) {
  return render(
    <QueryClientProvider client={qc}>
      <NavigationProvider value={navigation}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
}

/** A row like the board card's and list row's: an AppLink around the indicator. */
function inRow(ui: ReactNode) {
  return (
    <AppLink href="/acme/issues/CTG-1" data-testid="row">
      {ui}
    </AppLink>
  );
}

function anchorsInAnchors() {
  return document.querySelectorAll("a a").length;
}

beforeEach(() => {
  push.mockClear();
  mockRules.rules = [];
  mockRules.system = [];
});
afterEach(cleanup);

describe("splitIssueKeys", () => {
  it("cuts around the workspace's keys only", () => {
    expect(splitIssueKeys("blocked by CTG-2418 (backlog), GPT-5, CTG-2419", "CTG")).toEqual([
      { text: "blocked by ", isKey: false },
      { text: "CTG-2418", isKey: true },
      { text: " (backlog), GPT-5, ", isKey: false },
      { text: "CTG-2419", isKey: true },
    ]);
  });

  it("leaves everything as text without a prefix", () => {
    expect(splitIssueKeys("blocked by CTG-1", "")).toEqual([{ text: "blocked by CTG-1", isKey: false }]);
  });
});

describe("the wake label on a row", () => {
  it("links the waited-on key and navigates there instead of the row", () => {
    renderUi(inRow(<IssueAgentActivityIndicator issueId="issue-1" />));
    const link = screen.getByRole("link", { name: "CTG-2421" });
    expect(link.tagName).toBe("SPAN");
    expect(anchorsInAnchors()).toBe(0);

    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false); // the row's <a> would otherwise navigate natively
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/acme/issues/uuid-2421");
  });

  it("still lets the rest of the row open the row", () => {
    renderUi(inRow(<IssueAgentActivityIndicator issueId="issue-1" />));
    fireEvent.click(screen.getByTestId("row"));
    expect(push).toHaveBeenCalledWith("/acme/issues/CTG-1");
  });

  it("does not start a drag from the key", () => {
    const onPointerDown = vi.fn();
    renderUi(<div onPointerDown={onPointerDown}>{inRow(<IssueAgentActivityIndicator issueId="issue-1" />)}</div>);
    fireEvent.pointerDown(screen.getByRole("link", { name: "CTG-2421" }));
    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("stays plain text when the surface opted out of the hover card", () => {
    renderUi(inRow(<IssueAgentActivityIndicator issueId="issue-1" hoverCard={false} />));
    expect(screen.queryByRole("link", { name: "CTG-2421" })).toBeNull();
  });

  it("links the whole label when the condition has no key", () => {
    const row = { ...waitingRow, condition: { type: "other_issue", issue_id: "uuid-9", state: "done" } } as unknown as IssueWakeupSummaryRow;
    renderUi(inRow(<IssueAgentActivityIndicator issueId="issue-1" />), client([row]));
    fireEvent.click(screen.getByRole("link", { name: "Waiting for another issue" }));
    expect(push).toHaveBeenCalledWith("/acme/issues/uuid-9");
  });

  it("does not link a wake that waits on something else", () => {
    const row = { ...waitingRow, condition: undefined, event_types: ["task.completed"] } as unknown as IssueWakeupSummaryRow;
    renderUi(inRow(<IssueAgentActivityIndicator issueId="issue-1" />), client([row]));
    // Only the row's own anchor is a link.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("lists the key as a real link in the hover card, without opening the row", async () => {
    renderUi(inRow(<IssueAgentActivityIndicator issueId="issue-1" />));
    fireEvent.focus(screen.getByLabelText(/Waiting for CTG-2421/));
    const content = await waitFor(() => {
      const el = document.querySelector('[data-slot="hover-card-content"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const link = within(content).getByRole("link", { name: "CTG-2421" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/acme/issues/uuid-2421");
    expect(link.closest('[data-testid="row"]')).toBeNull();

    fireEvent.click(link);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/acme/issues/uuid-2421");
  });
});

describe("the Waiting on line", () => {
  const properties = (value: string) => ({ [PROPERTY_ID]: value });

  it("links its keys in the row, by key, leaving other text alone", () => {
    renderUi(inRow(<IssueWaitingOn properties={properties("blocked by CTG-2418 (backlog), CTG-2419 (in progress), GPT-5")} />));
    expect(screen.getByRole("link", { name: "CTG-2418" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "GPT-5" })).toBeNull();
    expect(anchorsInAnchors()).toBe(0);

    fireEvent.click(screen.getByRole("link", { name: "CTG-2419" }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/acme/issues/CTG-2419");
  });

  it("keeps the full text as a tooltip and renders no link when there are no keys", () => {
    renderUi(inRow(<IssueWaitingOn properties={properties("stuck: no run")} />));
    expect(document.querySelector('[data-slot="issue-waiting-on"]')?.getAttribute("title")).toBe("stuck: no run");
    expect(screen.getAllByRole("link")).toHaveLength(1); // the row
  });

  it("offers every key as a real link in the hover card", async () => {
    renderUi(inRow(<IssueWaitingOn properties={properties("blocked by CTG-2418, CTG-2419")} />));
    fireEvent.mouseEnter(document.querySelector('[data-slot="issue-waiting-on"]') as Element);
    fireEvent.pointerEnter(document.querySelector('[data-slot="issue-waiting-on"]') as Element);
    const content = await waitFor(
      () => {
        const el = document.querySelector('[data-slot="hover-card-content"]');
        expect(el).not.toBeNull();
        return el as HTMLElement;
      },
      { timeout: 2000 },
    );
    expect(within(content).getByRole("link", { name: "CTG-2418" }).getAttribute("href")).toBe("/acme/issues/CTG-2418");
    expect(within(content).getByRole("link", { name: "CTG-2419" }).getAttribute("href")).toBe("/acme/issues/CTG-2419");
  });
});

describe("the detail header chip", () => {
  const rule = (patch: Partial<IssueWakeup>) =>
    ({
      id: "w",
      issue_id: "issue",
      agent_id: "a",
      agent_name: "Emacs",
      instruction: "",
      kind: "event",
      mode: "once",
      event_types: [],
      timezone: "UTC",
      next_fire_at: null,
      enabled: true,
      disabled_at: null,
      last_task_id: null,
      last_error: null,
      ...patch,
    }) as IssueWakeup;

  it("makes the label a real link and leaves the icon opening the section", async () => {
    mockRules.rules = [rule({ condition: { type: "other_issue", issue_id: "uuid-2421", state: "done", identifier: "CTG-2421" } })];
    const onOpen = vi.fn();
    renderUi(<IssueWakeupHeaderChip issueId="issue" onOpen={onOpen} />);
    const link = await screen.findByRole("link", { name: /CTG-2421/ });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/acme/issues/uuid-2421");
    fireEvent.click(link);
    expect(push).toHaveBeenCalledWith("/acme/issues/uuid-2421");
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("stays a single button when the wait is not on an issue", async () => {
    mockRules.rules = [rule({ event_types: ["comment.created"] })];
    renderUi(<IssueWakeupHeaderChip issueId="issue" onOpen={() => {}} />);
    expect(await screen.findByRole("button")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("the wakeups section", () => {
  const waitingRule = {
    id: "w",
    issue_id: "issue",
    agent_id: "a",
    agent_name: "Emacs",
    instruction: "",
    kind: "event",
    mode: "once",
    event_types: [],
    timezone: "UTC",
    next_fire_at: null,
    enabled: true,
    disabled_at: null,
    last_task_id: null,
    last_error: null,
    condition: { type: "other_issue", issue_id: "uuid-2421", state: "done", identifier: "CTG-2421" },
  } as unknown as IssueWakeup;

  it("links the rule's icon to the issue without opening the rule's popover", async () => {
    mockRules.rules = [waitingRule];
    renderUi(<WakeupsSection issueId="issue" />);
    const link = await screen.findByRole("link", { name: "CTG-2421" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/acme/issues/uuid-2421");
    // A sibling of the row's button, never inside it.
    expect(link.closest("button")).toBeNull();

    fireEvent.click(link);
    expect(push).toHaveBeenCalledWith("/acme/issues/uuid-2421");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("links a system rule's waiting keys in its popover", async () => {
    mockRules.system = [
      {
        id: "rule",
        revision: 1,
        default_instruction: "",
        customized: false,
        paused_reason: null,
        rule: "child_done",
        enabled: true,
        instruction: "",
        staged: false,
        stage: null,
        total: 2,
        remaining: 2,
        waiting: ["CTG-7", "CTG-8"],
        target: { type: "agent", id: "a", name: "Grok" },
        blocked: "",
        workspace_default: true,
      },
    ];
    renderUi(<WakeupsSection issueId="issue" />);
    fireEvent.click(await screen.findByRole("button", { name: /Grok/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "CTG-7" }).getAttribute("href")).toBe("/acme/issues/CTG-7");
    expect(within(dialog).getByRole("link", { name: "CTG-8" }).getAttribute("href")).toBe("/acme/issues/CTG-8");
  });
});
