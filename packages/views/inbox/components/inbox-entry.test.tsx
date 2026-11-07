import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

let user: { smart_inbox?: boolean } | null = null;
vi.mock("@multica/core/auth", () => {
  const useAuthStore = (sel: (s: { user: typeof user }) => unknown) => sel({ user });
  useAuthStore.getState = () => ({ user });
  return { useAuthStore };
});
vi.mock("../../i18n", () => ({ useT: () => ({ t: () => "label" }) }));
vi.mock("./inbox-page", () => ({
  InboxPage: ({ headerAccessory, smart }: { headerAccessory?: ReactNode; smart?: boolean }) => (
    <div data-testid={smart ? "smart-two-pane" : "classic"}>{headerAccessory}</div>
  ),
}));
let compact = true;
vi.mock("@multica/ui/hooks/use-mobile", () => ({ useIsCompact: () => compact }));
vi.mock("./smart-inbox", () => ({
  SmartInboxPage: ({ headerAccessory }: { headerAccessory?: ReactNode }) => (
    <div data-testid="smart">{headerAccessory}</div>
  ),
}));

import { InboxEntryPage } from "./inbox-entry";

function renderAt(query: string) {
  const nav = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/inbox",
    searchParams: new URLSearchParams(query),
    hash: "",
  } as unknown as NavigationAdapter;
  return render(
    <NavigationProvider value={nav}>
      <InboxEntryPage />
    </NavigationProvider>,
  );
}

describe("InboxEntryPage", () => {
  beforeEach(() => {
    localStorage.clear();
    compact = true;
  });
  afterEach(() => vi.restoreAllMocks());

  it("is classic without a toggle for users the server has not enabled", () => {
    user = { smart_inbox: false };
    renderAt("smart-inbox=1");
    expect(screen.getByTestId("classic")).toBeEmptyDOMElement();
    expect(localStorage.getItem("multica:smart-inbox")).toBe("smart");
  });

  it("defaults to smart for enabled users, no opt-in needed (owner 2026-11-07)", () => {
    user = { smart_inbox: true };
    renderAt("");
    expect(screen.getByTestId("smart")).toBeInTheDocument();
    expect(localStorage.getItem("multica:smart-inbox")).toBeNull();
  });

  it("opts in from the URL, remembers it, and toggles back to classic", () => {
    user = { smart_inbox: true };
    const first = renderAt("smart-inbox=1");
    expect(screen.getByTestId("smart")).toBeInTheDocument();
    first.unmount();

    renderAt("");
    expect(screen.getByTestId("smart")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button")[1]!);
    expect(screen.getByTestId("classic")).not.toBeEmptyDOMElement();
    expect(localStorage.getItem("multica:smart-inbox")).toBe("classic");
  });

  it("picks and remembers classic on ?smart-inbox=0, keeping the toggle", () => {
    user = { smart_inbox: true };
    localStorage.setItem("multica:smart-inbox", "smart");
    renderAt("smart-inbox=0");
    expect(screen.getByTestId("classic")).not.toBeEmptyDOMElement();
    expect(localStorage.getItem("multica:smart-inbox")).toBe("classic");
  });

  it("uses Classic's two panes with smart sections from tablet width up", () => {
    user = { smart_inbox: true };
    compact = false;
    renderAt("smart-inbox=1");
    expect(screen.getByTestId("smart-two-pane")).not.toBeEmptyDOMElement();
    expect(screen.queryByTestId("smart")).toBeNull();
  });

  it("toggles with a single icon button in the two-pane header", () => {
    user = { smart_inbox: true };
    compact = false;
    renderAt("smart-inbox=1");
    const toggle = screen.getByRole("button", { pressed: true });
    fireEvent.click(toggle);
    expect(screen.getByTestId("classic")).not.toBeEmptyDOMElement();
    expect(screen.getByRole("button", { pressed: false })).toBeInTheDocument();
    expect(localStorage.getItem("multica:smart-inbox")).toBe("classic");
  });

  it("keeps the archive sub-view in the classic layout (the page renders it classic)", () => {
    user = { smart_inbox: true };
    renderAt("smart-inbox=1&view=archived");
    expect(screen.getByTestId("smart-two-pane")).not.toBeEmptyDOMElement();
    expect(screen.queryByTestId("smart")).toBeNull();
  });

  it("still works when storage throws", () => {
    user = { smart_inbox: true };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderAt("smart-inbox=1");
    expect(screen.getByTestId("smart")).toBeInTheDocument();
  });
});
