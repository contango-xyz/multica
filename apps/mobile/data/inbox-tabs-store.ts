/**
 * Tabs or sections for a tabs-flagged user (contango patch 45): Settings >
 * Inbox > "Tabbed inbox". Device-local like web's `multica:inbox-tabs`; the
 * server flag (`inbox_tabs` on /api/me) still decides whether the choice
 * applies at all. Persisted in expo-secure-store as the theme preference is;
 * until the read completes the default (tabs) applies.
 */
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import { parseInboxTabsMode, type InboxTabsMode } from "@/lib/inbox-tabs";

const STORAGE_KEY = "inbox-tabs-mode";

interface State {
  mode: InboxTabsMode;
  setMode: (mode: InboxTabsMode) => void;
  /** Reads the saved choice once; later calls are no-ops. */
  hydrate: () => void;
}

let hydrated = false;
let chosen = false;

export const useInboxTabsStore = create<State>((set) => ({
  mode: "tabs",
  setMode: (mode) => {
    hydrated = true;
    chosen = true;
    set({ mode });
    void SecureStore.setItemAsync(STORAGE_KEY, mode).catch(() => {
      // A failed write only forgets the choice on the next launch.
    });
  },
  hydrate: () => {
    if (hydrated) return;
    hydrated = true;
    SecureStore.getItemAsync(STORAGE_KEY)
      .then((saved) => {
        if (saved && !chosen) set({ mode: parseInboxTabsMode(saved) });
      })
      .catch(() => {
        // Read failures keep the default.
      });
  },
}));
