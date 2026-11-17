// Contango patch 51 (owner 2026-11-17): a signal's body renders as Markdown
// through RichContent, so the feeders' roll-ups show Multica's issue chips
// (the chip carries the card's live status) instead of raw `[CTG-N](mention://…)`.
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation/context";
import type { NavigationAdapter } from "../../navigation/types";

vi.mock("../../issues/hooks", () => ({ useResolveIssueIdentifier: () => null }));
vi.mock("../../issues/components/issue-chip", () => ({
  IssueChip: ({ issueId, fallbackLabel }: { issueId: string; fallbackLabel?: string; children?: ReactNode }) => (
    <span data-testid="issue-chip" data-issue-id={issueId}>
      {fallbackLabel}
    </span>
  ),
}));
vi.mock("../../issues/components/issue-hover-card", () => ({
  IssueHoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../editor/link-hover-card", () => ({ useLinkHover: () => ({}), LinkHoverCard: () => null }));
vi.mock("@multica/core/api", () => ({
  api: { getAttachmentTextContent: vi.fn() },
  PreviewTooLargeError: class extends Error {},
  PreviewUnsupportedError: class extends Error {},
}));
vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/paths")>()),
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
    projectDetail: (id: string) => `/acme/projects/${id}`,
  }),
  useWorkspaceSlug: () => "acme",
}));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

import { SignalBody } from "./signal-body";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function adapter(): NavigationAdapter {
  return {
    push: vi.fn(), replace: vi.fn(), back: vi.fn(), pathname: "/", searchParams: new URLSearchParams(), hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
  };
}

function renderBody(body: string) {
  return renderWithI18n(
    <NavigationProvider value={adapter()}>
      <SignalBody body={body} className="text-caption" />
    </NavigationProvider>,
  );
}

describe("SignalBody", () => {
  it("renders each mention://issue link as the issue chip, one line per card", () => {
    renderBody(
      `Why now: your daily MVP digest.\n- [CTG-2612](mention://issue/${A}): Merged without you · since 16 Nov\n` +
        `- [CTG-2386](mention://issue/${B}): MVP definition`,
    );
    const chips = screen.getAllByTestId("issue-chip");
    expect(chips.map((c) => c.getAttribute("data-issue-id"))).toEqual([A, B]);
    expect(chips[0]!.textContent).toBe("CTG-2612");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("signal-body").textContent).not.toContain("mention://");
    expect(screen.getByText(/Merged without you/)).toBeTruthy();
  });

  it("keeps a plain-text body's lines", () => {
    renderBody("Still open:\nCTG-1 waits on you\nCTG-2 too");
    const text = screen.getByTestId("signal-body");
    expect(text.textContent).toContain("Still open:");
    expect(text.querySelectorAll("br").length).toBeGreaterThanOrEqual(2);
  });
});
