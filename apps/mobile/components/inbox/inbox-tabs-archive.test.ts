// @vitest-environment node
// Contango patch 47 (owner 2026-11-13: "stupid not having archive buttons on the cards when hover"; a Today
// "CD is red" alert had no archive): every card type on every iOS tab is a swipe row with Archive. No native
// renderer here: the panels' element trees are expanded by calling our own components, and FlatList rows through
// their renderItem. Every titled card must sit inside a SwipeableInboxRow whose onArchive archives that card.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@multica/core/types";
import type { SmartEntry } from "@multica/core/inbox/smart";
import { buildMobileInboxTabs, type InboxTab } from "@/lib/inbox-tabs";
import { InboxTabPanel, type TabActions } from "./inbox-tabs";

vi.mock("react-native", () => ({
  FlatList: "FlatList", Linking: { openURL: vi.fn() }, Pressable: "Pressable", RefreshControl: "RefreshControl",
  ScrollView: "ScrollView", View: "View",
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("@/data/queries/inbox", () => ({ inboxSquadOptions: vi.fn() }));
vi.mock("@/data/workspace-store", () => ({ useWorkspaceStore: () => "ws-1" }));
vi.mock("@/lib/use-color-scheme", () => ({ useColorScheme: () => ({ colorScheme: "light" }) }));
vi.mock("@/lib/theme", () => ({ THEME: { light: { mutedForeground: "gray" } } }));
vi.mock("@/lib/i18n", () => ({ useT: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));
vi.mock("@/components/ui/button", () => ({ Button: "Button" }));
vi.mock("@/components/inbox/swipeable-inbox-row", () => ({ SwipeableInboxRow: "SwipeableInboxRow" }));
vi.mock("./use-signal-reply", () => ({ useSignalReply: () => ({ confirm: vi.fn(), busy: false }) }));


const NOW = Date.parse("2026-11-13T12:00:00Z");

function signal(id: string, group: string, details: Record<string, unknown> = {}, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id, workspace_id: "ws-1", recipient_type: "member", recipient_id: "me", actor_type: null, actor_id: null,
    type: "signal", severity: "action_required", issue_id: `issue-${id}`, title: `Card ${id}`, body: null,
    issue_status: null, read: false, archived: false, created_at: "2026-11-13T10:00:00Z",
    details: {
      key: `${group}:${id}`, group, summary: "CTG-1 · something",
      rank: { priority: "high", blocks: 1, since: "2026-11-13T09:00:00Z" }, ...details,
    } as unknown as InboxItem["details"],
    ...over,
  };
}

/** Text in a subtree, without expanding it. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

interface Swipe { text: string; onArchive: () => void }

/** Expand our function components and FlatList rows; collect every SwipeableInboxRow. */
function swipes(node: ReactNode, out: Swipe[] = []): Swipe[] {
  if (Array.isArray(node)) {
    for (const n of node) swipes(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return swipes((el.type as (p: unknown) => ReactNode)(el.props), out);
  if (el.type === "SwipeableInboxRow") {
    const inner = swipes(el.props.children as ReactNode);
    const item = el.props.item as InboxItem;
    out.push({ text: item.title + textOf(el.props.children as ReactNode), onArchive: el.props.onArchive as () => void });
    out.push(...inner);
    return out;
  }
  if (el.type === "FlatList") {
    const data = (el.props.data as unknown[]) ?? [];
    const renderItem = el.props.renderItem as (a: { item: unknown }) => ReactNode;
    for (const d of data) swipes(renderItem({ item: d }), out);
  }
  for (const key of ["children", "ListHeaderComponent", "ListFooterComponent"]) swipes(el.props[key] as ReactNode, out);
  return out;
}

describe("iOS inbox tabs: every card swipes to Archive", () => {
  const items = [
    signal("al", "alert", { key: "fix-main:core:main" }, { title: "CD is red" }),
    signal("td", "decision", {}, { title: "Today ask" }),
    signal("g1", "decision", {}, { issue_id: "issue-g", created_at: "2026-11-13T08:00:00Z", title: "Grouped older" }),
    signal("g2", "decision", {}, { issue_id: "issue-g", title: "Grouped newer" }),
    signal("mg", "merge", { merge: { pr: "#1", state: "open", url: "https://github.com/o/r/pull/1" } }, { title: "Approve merge #1" }),
    signal("pm", "merge", { key: "post-merge:CTG-9:core#2", merge: { pr: "#2", post_merge: true, url: "https://github.com/o/r/pull/2" } }, { title: "Merged #2" }),
    signal("fy", "fyi", {}, { severity: "info", title: "FYI" }),
  ];
  const model = buildMobileInboxTabs(items, NOW);

  const archived: string[][] = [];
  const actions: TabActions = {
    onOpen: vi.fn(),
    onArchive: (entries: SmartEntry[]) => archived.push(entries.map((e) => e.item.id)),
    onMarkRead: vi.fn(),
  } as unknown as TabActions;

  const panel = (tab: InboxTab) =>
    swipes(InboxTabPanel({ model, tab, onChangeTab: vi.fn(), actions, now: NOW, refreshing: false, onRefresh: vi.fn() }));

  const cases: [InboxTab, string, string[]][] = [
    ["today", "CD is red", ["al"]],
    ["today", "Today ask", ["td"]],
    ["today", "Grouped newer", ["g2", "g1"]],
    ["decisions", "Today ask", ["td"]],
    ["decisions", "Grouped newer", ["g2", "g1"]],
    ["merges", "Approve merge #1", ["mg"]],
    ["merges", "Merged #2", ["pm"]],
    ["else", "FYI", ["fy"]],
    ["else", "CD is red", ["al"]],
  ];
  it.each(cases)("%s: %s", (tab, title, ids) => {
    const row = panel(tab).find((s) => s.text.includes(title));
    expect(row, `${tab} has a swipe row for ${title}`).toBeDefined();
    archived.length = 0;
    row!.onArchive();
    expect(archived).toHaveLength(1);
    expect([...archived[0]!].sort()).toEqual([...ids].sort());
  });
});
