import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SmartEntry, SmartSection } from "@multica/core/inbox/smart";
import type { InboxItem } from "@multica/core/types";

vi.mock("../../i18n", () => ({
  useT: () => ({ t: (sel: (p: unknown) => unknown) => {
    const path: string[] = [];
    const proxy: unknown = new Proxy({}, { get: (_t, k) => { path.push(String(k)); return proxy; } });
    sel(proxy);
    return path.join(".");
  } }),
}));
vi.mock("./smart-inbox", () => ({ useReasonText: () => (e: SmartEntry) => `reason ${e.item.id}` }));
vi.mock("./inbox-list-item", () => ({
  InboxListItem: ({
    item,
    isSelected,
    onClick,
    onAction,
  }: {
    item: InboxItem;
    isSelected: boolean;
    onClick: () => void;
    onAction: () => void;
  }) => (
    <div data-testid="row" data-selected={String(isSelected)}>
      <button type="button" onClick={onClick}>{item.id}</button>
      <button type="button" onClick={onAction}>archive {item.id}</button>
    </div>
  ),
}));

import { SmartInboxList } from "./smart-inbox-list";

const entry = (id: string, over: Partial<InboxItem> = {}, needsYou = false): SmartEntry => ({
  item: { id, issue_id: `issue-${id}`, type: "signal", ...over } as InboxItem,
  signal: null,
  score: 1,
  reason: { priority: "none", blocks: 0, hours: 0 },
  needsYou,
  waitedHours: 0,
});

const sections: SmartSection[] = [
  { id: "merge", entries: [entry("a", {}, true), entry("b")] },
  { id: "mentions", entries: [entry("m", { type: "mentioned", issue_id: "issue-a" }, true)] },
];

function renderList(selectedKey = "") {
  const props = {
    onSelect: vi.fn(),
    onAction: vi.fn(),
    onArchiveSection: vi.fn(),
    onMarkSectionRead: vi.fn(),
    onOpenArchived: vi.fn(),
  };
  render(<SmartInboxList sections={sections} selectedKey={selectedKey} {...props} />);
  return props;
}

describe("SmartInboxList", () => {
  it("renders section headers with count and the top entry's reason over classic rows", () => {
    renderList();
    const merge = screen.getByRole("region", { name: /smart\.sections\.merge/ });
    expect(within(merge).getByRole("heading")).toHaveTextContent("smart.sections.merge · 2 · reason a");
    expect(within(merge).getAllByTestId("row")).toHaveLength(2);
  });

  it("marks the selected row by its row key (signals by id, others by issue)", () => {
    renderList("issue-a");
    const selected = screen.getAllByTestId("row").filter((r) => r.dataset.selected === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("m");
  });

  it("selects, archives rows and walks them with the arrow keys across sections", () => {
    const props = renderList("b");
    fireEvent.click(screen.getByRole("button", { name: "a" }));
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
    fireEvent.click(screen.getByRole("button", { name: "archive b" }));
    expect(props.onAction).toHaveBeenCalledWith("b");
    fireEvent.keyDown(screen.getByRole("button", { name: "a" }), { key: "ArrowDown" });
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "m" }));
  });

  it("selects nothing until asked, then the first arrow press opens the first row", () => {
    const props = renderList("");
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "a" }), { key: "ArrowDown" });
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("offers the archive entry below the sections", () => {
    const props = renderList();
    fireEvent.click(screen.getByRole("button", { name: /list\.archived_title/ }));
    expect(props.onOpenArchived).toHaveBeenCalled();
  });
});
