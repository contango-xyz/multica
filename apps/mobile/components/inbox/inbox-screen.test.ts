// @vitest-environment node
import type { InboxItem } from "@multica/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "expo-router";
import Inbox from "@/app/(app)/[workspace]/(tabs)/inbox";

const state = vi.hoisted(() => ({
  rows: [] as InboxItem[], markRead: vi.fn(), archive: vi.fn(), smartInbox: false, inboxTabs: false,
  tabsMode: "tabs" as "tabs" | "sections",
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useMemo: (create: () => unknown) => create(),
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useState: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({
  ActionSheetIOS: {}, Alert: {}, FlatList: "FlatList", SectionList: "SectionList", View: "View",
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.rows, dataUpdatedAt: Date.parse("2026-06-15T12:00:00Z") }),
}));
vi.mock("@/data/queries/inbox", () => ({ inboxListOptions: vi.fn() }));
vi.mock("@/data/mutations/inbox", () => {
  const mutation = () => ({ mutate: vi.fn() });
  return {
    useMarkInboxRead: () => ({ mutate: state.markRead }),
    useMarkAllInboxRead: mutation,
    useArchiveInbox: () => ({ mutate: state.archive }),
    useArchiveAllInbox: mutation,
    useArchiveAllReadInbox: mutation,
    useArchiveCompletedInbox: mutation,
  };
});
vi.mock("@/data/workspace-store", () => ({
  useWorkspaceStore: (selector: (value: unknown) => unknown) => selector({
    currentWorkspaceId: "workspace-1", currentWorkspaceSlug: "acme",
  }),
}));
vi.mock("@/data/auth-store", () => ({
  useAuthStore: (selector: (value: unknown) => unknown) => selector({
    user: { id: "member-1", smart_inbox: state.smartInbox, inbox_tabs: state.inboxTabs },
  }),
}));
vi.mock("@/lib/use-color-scheme", () => ({ useColorScheme: () => ({ colorScheme: "light" }) }));
vi.mock("@/lib/theme", () => ({ THEME: { light: { mutedForeground: "gray" } } }));
vi.mock("@/lib/i18n", () => ({ useT: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));
vi.mock("@/components/ui/button", () => ({ Button: "Button" }));
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: "Skeleton" }));
vi.mock("@/components/ui/header", () => ({ Header: "Header" }));
vi.mock("@/components/ui/icon-button", () => ({ IconButton: "IconButton" }));
vi.mock("@/components/ui/app-header-actions", () => ({ HeaderActions: "HeaderActions" }));
vi.mock("@/components/inbox/swipeable-inbox-row", () => ({ SwipeableInboxRow: "SwipeableInboxRow" }));
vi.mock("@/components/inbox/inbox-tabs", () => ({ InboxTabStrip: "InboxTabStrip", InboxTabPanel: "InboxTabPanel" }));
vi.mock("@/data/inbox-tabs-store", () => ({
  useInboxTabsStore: (selector: (value: unknown) => unknown) => selector({ mode: state.tabsMode, hydrate: () => {} }),
}));

describe("Inbox navigation wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.smartInbox = false;
    state.inboxTabs = false;
    state.tabsMode = "tabs";
  });

  it.each([true, false])("reads the whole issue before navigation when the latest row read=%s", (read) => {
    const comment: InboxItem = {
      id: "comment", workspace_id: "workspace-1", recipient_type: "member",
      recipient_id: "member-1", actor_type: "agent", actor_id: "agent-1",
      type: "new_comment", severity: "info", issue_id: "issue-1", title: "Issue",
      body: null, issue_status: "todo", read, archived: false,
      created_at: "2026-06-15T08:01:00Z", details: null,
    };
    state.rows = [comment, {
      ...comment, id: "assigned", type: "issue_assigned", severity: "action_required",
      read: false, created_at: "2026-06-15T08:00:00Z",
    }];

    // Inspect props and invoke the tap callback without rendering native UI.
    const list = Inbox().props.children[1];
    expect(list.props.data).toEqual([comment]);
    list.props.renderItem({ item: comment }).props.onPress();

    expect(state.markRead).toHaveBeenCalledExactlyOnceWith("comment");
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({
      pathname: "/[workspace]/issue/[id]",
      params: expect.objectContaining({ workspace: "acme", id: "issue-1" }),
    }));
    expect(state.markRead.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(router.push).mock.invocationCallOrder[0]!);
  });

  it("lists signals in ranked sections and opens a signal's brief when the server flag is on", () => {
    state.smartInbox = true;
    const base = {
      workspace_id: "workspace-1", recipient_type: "member" as const, recipient_id: "member-1",
      body: null, issue_status: null, archived: false,
    };
    const signal: InboxItem = {
      ...base, id: "sig", actor_type: "system", actor_id: null, type: "signal",
      severity: "action_required", issue_id: "issue-1", title: "Approve merge #12", read: false,
      created_at: "2026-06-15T08:00:00Z",
      details: { key: "k", group: "merge", summary: "blocks 2 cards" } as InboxItem["details"],
    };
    const comment: InboxItem = {
      ...base, id: "comment", actor_type: "agent", actor_id: "agent-1", type: "new_comment",
      severity: "info", issue_id: "issue-2", title: "Other", read: true,
      created_at: "2026-06-15T09:00:00Z", details: null,
    };
    state.rows = [comment, signal];

    const list = Inbox().props.children[1];
    expect(list.type).toBe("SectionList");
    expect(list.props.sections.map((section: { id: string }) => section.id)).toEqual(["merge", "fyi"]);
    const row = list.props.renderItem({ item: list.props.sections[0].data[0] });
    expect(row.props.inSmartSection).toBe(true);
    row.props.onPress();

    expect(state.markRead).toHaveBeenCalledExactlyOnceWith("sig");
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/[workspace]/inbox/[id]",
      params: { workspace: "acme", id: "sig" },
    });
  });

  describe("tabs (contango patch 45)", () => {
    const base = {
      workspace_id: "workspace-1", recipient_type: "member" as const, recipient_id: "member-1",
      body: null, issue_status: null, archived: false,
    };
    const ask: InboxItem = {
      ...base, id: "ask", actor_type: "system", actor_id: null, type: "signal",
      severity: "action_required", issue_id: "issue-1", title: "Pick a provider", read: false,
      created_at: "2026-06-15T08:00:00Z",
      details: { key: "k", group: "decision", summary: "CTG-1 · frees 2", rank: { priority: "high", blocks: 2, since: "2026-06-15T08:00:00Z" } } as unknown as InboxItem["details"],
    };
    const mention: InboxItem = {
      ...base, id: "mention", actor_type: "agent", actor_id: "agent-1", type: "mentioned",
      severity: "info", issue_id: "issue-1", title: "Pick a provider", read: false,
      created_at: "2026-06-15T09:00:00Z", details: null,
    };

    it("opens on Today with the tab strip when both server flags are on", () => {
      state.smartInbox = true;
      state.inboxTabs = true;
      state.rows = [ask, mention];

      const body = Inbox().props.children[1];
      const [strip, panel] = body.props.children;
      expect(strip.type).toBe("InboxTabStrip");
      expect(strip.props.tab).toBe("today");
      expect(panel.type).toBe("InboxTabPanel");
      expect(panel.props.tab).toBe("today");
      // The mention folds into the ask: one row on Today and on Decisions.
      expect(panel.props.model.today.rows.map((r: { entry: { item: InboxItem } }) => r.entry.item.id)).toEqual(["ask"]);
      expect(panel.props.model.decisions).toHaveLength(1);

      // Opening a row reads it, then shows its brief; nothing opens on its own.
      expect(router.push).not.toHaveBeenCalled();
      panel.props.actions.onOpen(ask);
      expect(state.markRead).toHaveBeenCalledWith("ask");
      expect(router.push).toHaveBeenCalledWith({
        pathname: "/[workspace]/inbox/[id]",
        params: { workspace: "acme", id: "ask" },
      });
    });

    it("archives and reads a row's card once, only from the row's own action", () => {
      state.smartInbox = true;
      state.inboxTabs = true;
      state.rows = [ask, mention];
      const panel = Inbox().props.children[1].props.children[1];
      expect(state.archive).not.toHaveBeenCalled();
      const row = panel.props.model.decisions[0];
      panel.props.actions.onArchive(row.entries);
      expect(state.archive).toHaveBeenCalledExactlyOnceWith("ask");
      panel.props.actions.onMarkRead(row.entries);
      expect(state.markRead).toHaveBeenCalledExactlyOnceWith("ask");
    });

    it("keeps the sections view when the user turned tabs off in Settings, or without the tabs flag", () => {
      state.smartInbox = true;
      state.inboxTabs = true;
      state.tabsMode = "sections";
      state.rows = [ask];
      expect(Inbox().props.children[1].type).toBe("SectionList");

      state.tabsMode = "tabs";
      state.inboxTabs = false;
      expect(Inbox().props.children[1].type).toBe("SectionList");
    });
  });
});
