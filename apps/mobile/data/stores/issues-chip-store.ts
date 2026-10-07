/**
 * Remembers the selected Issues-tab chip per workspace across restarts.
 * Values are chip ids ("builtin:all" | "view:<uuid>"); resolution against the
 * live chip list (deleted views → All) happens in lib/issues-chips.ts.
 */
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const keyFor = (wsId: string) => `multica_issues_chip_${wsId}`;

interface IssuesChipState {
  rememberedByWs: Record<string, string>;
  remember: (wsId: string, chipId: string) => void;
  hydrate: (wsId: string) => Promise<void>;
}

export const useIssuesChipStore = create<IssuesChipState>((set, get) => ({
  rememberedByWs: {},
  remember: (wsId, chipId) => {
    set((s) => ({ rememberedByWs: { ...s.rememberedByWs, [wsId]: chipId } }));
    SecureStore.setItemAsync(keyFor(wsId), chipId).catch(() => {});
  },
  hydrate: async (wsId) => {
    if (get().rememberedByWs[wsId]) return;
    const stored = await SecureStore.getItemAsync(keyFor(wsId)).catch(() => null);
    if (stored) set((s) => ({ rememberedByWs: { ...s.rememberedByWs, [wsId]: stored } }));
  },
}));
