/**
 * Issues-tab state remembered per workspace across restarts: the selected
 * chip ("builtin:all" | "view:<uuid>") and, per chip, the collapsed status
 * sections. Resolution against the live chip list (deleted views → All)
 * happens in lib/issues-chips.ts.
 */
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import type { IssueStatus } from "@multica/core/types";
import { toggleCollapsed, type CollapsedByChip } from "@/lib/collapsed-sections";

const chipKey = (wsId: string) => `multica_issues_chip_${wsId}`;
const collapsedKey = (wsId: string) => `multica_issues_collapsed_${wsId}`;

interface IssuesChipState {
  rememberedByWs: Record<string, string>;
  collapsedByWs: Record<string, CollapsedByChip>;
  remember: (wsId: string, chipId: string) => void;
  toggleSection: (wsId: string, chipId: string, status: IssueStatus) => void;
  hydrate: (wsId: string) => Promise<void>;
}

function parseCollapsed(raw: string | null): CollapsedByChip | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CollapsedByChip) : null;
  } catch {
    return null;
  }
}

export const useIssuesChipStore = create<IssuesChipState>((set, get) => ({
  rememberedByWs: {},
  collapsedByWs: {},
  remember: (wsId, chipId) => {
    set((s) => ({ rememberedByWs: { ...s.rememberedByWs, [wsId]: chipId } }));
    SecureStore.setItemAsync(chipKey(wsId), chipId).catch(() => {});
  },
  toggleSection: (wsId, chipId, status) => {
    const next = toggleCollapsed(get().collapsedByWs[wsId] ?? {}, chipId, status);
    set((s) => ({ collapsedByWs: { ...s.collapsedByWs, [wsId]: next } }));
    SecureStore.setItemAsync(collapsedKey(wsId), JSON.stringify(next)).catch(() => {});
  },
  hydrate: async (wsId) => {
    const state = get();
    const [chip, collapsed] = await Promise.all([
      state.rememberedByWs[wsId] ? null : SecureStore.getItemAsync(chipKey(wsId)).catch(() => null),
      state.collapsedByWs[wsId] ? null : SecureStore.getItemAsync(collapsedKey(wsId)).catch(() => null),
    ]);
    const parsed = parseCollapsed(collapsed);
    set((s) => ({
      rememberedByWs: chip ? { ...s.rememberedByWs, [wsId]: chip } : s.rememberedByWs,
      collapsedByWs: parsed ? { ...s.collapsedByWs, [wsId]: parsed } : s.collapsedByWs,
    }));
  },
}));
