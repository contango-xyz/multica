/**
 * @vitest-environment jsdom
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";

const { getIssue, push, openInNewTab } = vi.hoisted(() => ({
  getIssue: vi.fn(),
  push: vi.fn(),
  openInNewTab: vi.fn(),
}));

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { getIssue },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-1", issue_prefix: "CTG" }),
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/contango/issues/${id}` }),
}));

vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => ({ iconOf: () => null, colorOf: () => null }),
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push, openInNewTab }),
}));

import { ApiError } from "@multica/core/api";
import { IssueIdJumpInput, IssueRefJump } from "./issue-ref-jump";

const DONE_ISSUE = {
  id: "issue-2850",
  identifier: "CTG-2850",
  number: 2850,
  title: "Find an issue by id",
  status: "done",
  status_category: "completed",
};

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function typeInto(value: string) {
  const box = screen.getByRole("searchbox");
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value } });
  return box;
}

describe("IssueIdJumpInput", () => {
  beforeEach(() => {
    getIssue.mockReset();
    push.mockReset();
    openInNewTab.mockReset();
  });

  it.each(["CTG-2850", "ctg 2850", "#2850", "2850"])(
    "pins the exact issue for %j with the indexed lookup, closed or not, and Enter opens it",
    async (typed) => {
      getIssue.mockResolvedValue(DONE_ISSUE);
      renderWithQuery(<IssueIdJumpInput />);
      const box = typeInto(typed);

      const row = await screen.findByRole("button", { name: "Go to CTG-2850" });
      expect(row).toHaveTextContent("Find an issue by id");
      expect(getIssue).toHaveBeenCalledWith("CTG-2850");

      fireEvent.keyDown(box, { key: "Enter" });
      expect(push).toHaveBeenCalledWith("/contango/issues/CTG-2850");
      expect(box).toHaveValue("");
    },
  );

  it("says so when the id doesn't exist, and Enter does nothing", async () => {
    getIssue.mockRejectedValue(new ApiError("issue not found", 404, "Not Found"));
    renderWithQuery(<IssueIdJumpInput />);
    const box = typeInto("CTG-999999");

    expect(await screen.findByText("CTG-999999 doesn't exist in this workspace")).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(push).not.toHaveBeenCalled();
  });

  it("explains what it takes for plain words, without a lookup", () => {
    renderWithQuery(<IssueIdJumpInput />);
    typeInto("login bug");
    expect(screen.getByText("Type an issue ID, like CTG-123")).toBeInTheDocument();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("opens in a new tab on Cmd+click", async () => {
    getIssue.mockResolvedValue(DONE_ISSUE);
    renderWithQuery(<IssueIdJumpInput />);
    typeInto("2850");
    fireEvent.click(await screen.findByRole("button", { name: "Go to CTG-2850" }), { metaKey: true });
    expect(openInNewTab).toHaveBeenCalledWith("/contango/issues/CTG-2850", "CTG-2850");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("IssueRefJump around another search box", () => {
  it("leaves the box's own text alone and adds the pinned row only for ids", async () => {
    getIssue.mockReset();
    getIssue.mockResolvedValue(DONE_ISSUE);
    const { rerender } = renderWithQuery(
      <IssueRefJump query="flaky test">
        <input role="searchbox" defaultValue="flaky test" />
      </IssueRefJump>,
    );
    fireEvent.focus(screen.getByRole("searchbox"));
    expect(screen.queryByRole("button", { name: /Go to/ })).toBeNull();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <IssueRefJump query="ctg-2850">
          <input role="searchbox" defaultValue="ctg-2850" />
        </IssueRefJump>
      </QueryClientProvider>,
    );
    fireEvent.focus(screen.getByRole("searchbox"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Go to CTG-2850" })).toBeInTheDocument());
  });
});
