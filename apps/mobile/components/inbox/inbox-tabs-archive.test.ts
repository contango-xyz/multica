// @vitest-environment node
// Contango patch 47 (owner 2026-11-13: "stupid not having archive buttons on the cards when hover"; a Today
// "CD is red" alert had no archive): every card type on every iOS tab is a swipe row with Archive. No native
// renderer here: the panels' element trees are expanded by calling our own components, and FlatList rows through
// their renderItem. Every titled card must sit inside a SwipeableInboxRow whose onArchive archives that card.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@multica/core/types";
import type { SmartEntry } from "@multica/core/inbox/smart";
import { everyInboxKind, unreadBadgeKeys } from "@multica/core/inbox/smart-tabs.fixture";
import { buildMobileInboxTabs, INBOX_TABS, type InboxTab } from "@/lib/inbox-tabs";
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
    signal("rm", "decision", {
      key: "reminder:pending",
      actions: [{ label: "Open CTG-2612", url: "https://multica.example/ws-1/issues/CTG-2612" }],
    }, { issue_id: null, title: "2 asks waiting on you", body: "Still open:\n- CTG-2612: Merged without you" }),
    signal("mm", "merge", { merge: { pr: "#3", state: "merged" } }, { title: "Approve merge #3" }),
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
    // Patch 49: a card-less reminder is a Today notice; a finished merge ask is Everything else's.
    ["today", "2 asks waiting on you", ["rm"]],
    ["else", "Approve merge #3", ["mm"]],
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

// Contango patch 49 (owner 2026-11-16): the badge counted a card-less reminder no tab showed.
describe("iOS inbox tabs: whatever the unread badge counts has a swipe row", () => {
  it("every kind of entry is on some tab", () => {
    const raw = everyInboxKind(NOW).flatMap((c) => c.items);
    const model = buildMobileInboxTabs(raw, NOW);
    const actions = { onOpen: vi.fn(), onArchive: vi.fn(), onMarkRead: vi.fn(), onOpenUrl: vi.fn() } as unknown as TabActions;
    const shown = new Set<string>();
    for (const tab of INBOX_TABS) {
      const tree = InboxTabPanel({ model, tab, onChangeTab: vi.fn(), actions, now: NOW, refreshing: false, onRefresh: vi.fn() });
      for (const row of rows(tree)) shown.add(row.issue_id ?? row.id);
    }
    expect([...unreadBadgeKeys(raw)].filter((k) => !shown.has(k))).toEqual([]);
  });

  it("a notice's link button opens its url", () => {
    const onOpenUrl = vi.fn();
    const reminder = signal("rm", "decision", {
      key: "reminder:pending",
      actions: [{ label: "Open CTG-2612", url: "https://multica.example/ws-1/issues/CTG-2612" }],
    }, { issue_id: null, title: "2 asks waiting on you" });
    const model = buildMobileInboxTabs([reminder], NOW);
    expect(model.today.notices.map((e) => e.item.id)).toEqual(["rm"]);
    const actions = { onOpen: vi.fn(), onArchive: vi.fn(), onMarkRead: vi.fn(), onOpenUrl } as unknown as TabActions;
    const button = find(InboxTabPanel({ model, tab: "today", onChangeTab: vi.fn(), actions, now: NOW, refreshing: false, onRefresh: vi.fn() }),
      (el) => el.type === "Button" && el.props.accessibilityLabel === "Open CTG-2612");
    expect(button).toBeDefined();
    (button!.props.onPress as () => void)();
    expect(onOpenUrl).toHaveBeenCalledWith("https://multica.example/ws-1/issues/CTG-2612");
  });
});

/** Every SwipeableInboxRow's item, with our components and FlatList rows expanded. */
function rows(node: ReactNode, out: InboxItem[] = []): InboxItem[] {
  walk(node, (el) => {
    if (el.type === "SwipeableInboxRow") out.push(el.props.item as InboxItem);
  });
  return out;
}

function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean) {
  let hit: ReactElement<Record<string, unknown>> | undefined;
  walk(node, (el) => {
    if (!hit && pred(el)) hit = el;
  });
  return hit;
}

function walk(node: ReactNode, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return walk((el.type as (p: unknown) => ReactNode)(el.props), visit);
  visit(el);
  if (el.type === "FlatList") {
    const data = (el.props.data as unknown[]) ?? [];
    const renderItem = el.props.renderItem as (a: { item: unknown }) => ReactNode;
    for (const d of data) walk(renderItem({ item: d }), visit);
  }
  for (const key of ["children", "ListHeaderComponent", "ListFooterComponent"]) walk(el.props[key] as ReactNode, visit);
}
