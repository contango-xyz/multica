// Smart-inbox-only filters (contango, docs/contango/SMART-INBOX.md), kept per
// workspace in memory exactly like the classic inbox filters (filter-store.ts).

import { create } from "zustand";
import type { SmartSection, SmartSectionId } from "./smart";

export interface SmartInboxFilters {
  /** Sections to show; empty = all. */
  readonly groups: readonly SmartSectionId[];
  /** Only entries waiting on the reader (action_required, mentions, reviews). */
  readonly needsYouOnly: boolean;
}

export const EMPTY_SMART_INBOX_FILTERS: SmartInboxFilters = Object.freeze({
  groups: Object.freeze([]),
  needsYouOnly: false,
});

export function smartInboxFilterCount(filters: SmartInboxFilters): number {
  return filters.groups.length + (filters.needsYouOnly ? 1 : 0);
}

/** Applies the smart filters to built sections; sections left empty drop out. */
export function filterSmartSections(
  sections: SmartSection[],
  filters: SmartInboxFilters,
): SmartSection[] {
  if (smartInboxFilterCount(filters) === 0) return sections;
  const out: SmartSection[] = [];
  for (const section of sections) {
    if (filters.groups.length > 0 && !filters.groups.includes(section.id)) continue;
    const entries = filters.needsYouOnly
      ? section.entries.filter((e) => e.needsYou)
      : section.entries;
    if (entries.length > 0) out.push(entries === section.entries ? section : { ...section, entries });
  }
  return out;
}

interface SmartInboxFilterState {
  filtersByWorkspace: Record<string, SmartInboxFilters>;
  toggleGroup: (wsId: string, group: SmartSectionId) => void;
  toggleNeedsYouOnly: (wsId: string) => void;
  clearSmartFilters: (wsId: string) => void;
}

export const useSmartInboxFilterStore = create<SmartInboxFilterState>()((set) => ({
  filtersByWorkspace: {},
  toggleGroup: (wsId, group) =>
    set((state) => {
      const current = state.filtersByWorkspace[wsId] ?? EMPTY_SMART_INBOX_FILTERS;
      const groups = current.groups.includes(group)
        ? current.groups.filter((g) => g !== group)
        : [...current.groups, group];
      return { filtersByWorkspace: { ...state.filtersByWorkspace, [wsId]: { ...current, groups } } };
    }),
  toggleNeedsYouOnly: (wsId) =>
    set((state) => {
      const current = state.filtersByWorkspace[wsId] ?? EMPTY_SMART_INBOX_FILTERS;
      return {
        filtersByWorkspace: {
          ...state.filtersByWorkspace,
          [wsId]: { ...current, needsYouOnly: !current.needsYouOnly },
        },
      };
    }),
  clearSmartFilters: (wsId) =>
    set((state) => {
      if (!state.filtersByWorkspace[wsId]) return state;
      const next = { ...state.filtersByWorkspace };
      delete next[wsId];
      return { filtersByWorkspace: next };
    }),
}));

/** Stable per-workspace selector. */
export function useSmartInboxFilters(wsId: string): SmartInboxFilters {
  return useSmartInboxFilterStore(
    (state) => state.filtersByWorkspace[wsId] ?? EMPTY_SMART_INBOX_FILTERS,
  );
}
