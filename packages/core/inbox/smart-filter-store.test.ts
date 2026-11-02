// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import type { SmartEntry, SmartSection } from "./smart";
import {
  filterSmartSections,
  smartInboxFilterCount,
  useSmartInboxFilterStore,
} from "./smart-filter-store";

const entry = (id: string, needsYou: boolean, priority: SmartEntry["reason"]["priority"] = "none"): SmartEntry => ({
  item: { id } as InboxItem,
  signal: null,
  score: 1,
  reason: { priority, blocks: 0, hours: 0 },
  needsYou,
  waitedHours: 0,
});

const sections: SmartSection[] = [
  { id: "merge", entries: [entry("m1", true), entry("m2", false, "urgent")] },
  { id: "stalled", entries: [entry("s1", false)] },
  { id: "fyi", entries: [entry("f1", false)] },
];

describe("filterSmartSections", () => {
  it("passes everything through with no filters", () => {
    expect(filterSmartSections(sections, { groups: [], needsYouOnly: false, urgentOnly: false })).toBe(sections);
  });

  it("keeps only the selected groups", () => {
    const out = filterSmartSections(sections, { groups: ["stalled", "fyi"], needsYouOnly: false, urgentOnly: false });
    expect(out.map((s) => s.id)).toEqual(["stalled", "fyi"]);
  });

  it("keeps only entries that need you, dropping emptied sections", () => {
    const out = filterSmartSections(sections, { groups: [], needsYouOnly: true, urgentOnly: false });
    expect(out.map((s) => [s.id, s.entries.map((e) => e.item.id)])).toEqual([["merge", ["m1"]]]);
  });
});

describe("urgent filter", () => {
  it("keeps only urgent entries", () => {
    const out = filterSmartSections(sections, { groups: [], needsYouOnly: false, urgentOnly: true });
    expect(out.map((s) => [s.id, s.entries.map((e) => e.item.id)])).toEqual([["merge", ["m2"]]]);
  });
});

describe("useSmartInboxFilterStore", () => {
  beforeEach(() => useSmartInboxFilterStore.setState({ filtersByWorkspace: {} }));

  it("toggles per workspace and clears", () => {
    const s = useSmartInboxFilterStore.getState();
    s.toggleGroup("ws", "merge");
    s.toggleGroup("ws", "alert");
    s.toggleGroup("ws", "merge");
    s.toggleNeedsYouOnly("ws");
    const ws = useSmartInboxFilterStore.getState().filtersByWorkspace.ws!;
    expect(ws).toEqual({ groups: ["alert"], needsYouOnly: true, urgentOnly: false });
    expect(smartInboxFilterCount(ws)).toBe(2);
    expect(useSmartInboxFilterStore.getState().filtersByWorkspace.other).toBeUndefined();
    s.clearSmartFilters("ws");
    expect(useSmartInboxFilterStore.getState().filtersByWorkspace.ws).toBeUndefined();
  });

  it("focuses one group from a counter and clears it on a second click", () => {
    const s = useSmartInboxFilterStore.getState();
    s.toggleGroup("ws", "merge");
    s.toggleGroup("ws", "alert");
    s.focusGroup("ws", "decision");
    expect(useSmartInboxFilterStore.getState().filtersByWorkspace.ws!.groups).toEqual(["decision"]);
    s.focusGroup("ws", "decision");
    expect(useSmartInboxFilterStore.getState().filtersByWorkspace.ws!.groups).toEqual([]);
    s.toggleUrgentOnly("ws");
    expect(useSmartInboxFilterStore.getState().filtersByWorkspace.ws!.urgentOnly).toBe(true);
  });
});
