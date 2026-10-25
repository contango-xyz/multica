// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import type { IssueDependencyRef } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => buildIssueStatusCatalog(undefined),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { IssueDependenciesSection, IssueDependencyMarker } from "./issue-dependencies";

function ref(id: string, number: number, status: string): IssueDependencyRef {
  return { id, identifier: `CTG-${number}`, number, title: `Card ${number}`, status };
}

afterEach(cleanup);

describe("IssueDependenciesSection", () => {
  it("lists both sides as links and collapses a section", () => {
    renderWithI18n(
      <IssueDependenciesSection
        issue={{ blocked_by: [ref("a", 1, "in_progress")], blocks: [ref("b", 2, "todo"), ref("c", 3, "done")] }}
      />,
    );
    expect(screen.getByText("Blocked by")).toBeTruthy();
    expect(screen.getByText("CTG-1").closest("a")?.getAttribute("href")).toBe("/acme/issues/a");
    expect(screen.getByText("CTG-3").closest("a")?.getAttribute("href")).toBe("/acme/issues/c");
    fireEvent.click(screen.getByText("Blocks"));
    expect(screen.queryByText("CTG-2")).toBeNull();
  });

  it("renders nothing without dependencies", () => {
    const { container } = renderWithI18n(<IssueDependenciesSection issue={{}} />);
    expect(container.textContent).toBe("");
  });
});

describe("IssueDependencyMarker", () => {
  it("counts only open dependencies and lists them in the tooltip", () => {
    renderWithI18n(
      <IssueDependencyMarker
        issue={{
          blocked_by: [ref("a", 1, "in_progress"), ref("b", 2, "done"), ref("c", 3, "cancelled")],
          blocks: [ref("d", 4, "todo"), ref("e", 5, "backlog")],
        }}
      />,
    );
    const blockedBy = screen.getByText("Blocked by 1");
    expect(blockedBy.getAttribute("title")).toBe("CTG-1 Card 1");
    expect(screen.getByText("Blocks 2").getAttribute("title")).toBe("CTG-4 Card 4\nCTG-5 Card 5");
  });

  it("renders nothing when every dependency is closed", () => {
    const { container } = renderWithI18n(
      <IssueDependencyMarker issue={{ blocked_by: [ref("a", 1, "done")], blocks: [] }} />,
    );
    expect(container.textContent).toBe("");
  });
});
