import { beforeEach, describe, expect, it } from "vitest";
import { getActiveTab, useTabStore } from "../stores/tab-store";
import { openExternalTarget } from "./open-external-target";

const activeUrl = () => getActiveTab(useTabStore.getState())?.url;

// What the navigation adapter does from a pinned tab: open (or focus) a tab.
const pushViaOpenTab = (path: string) => {
  useTabStore.getState().openTab(path, "", { activate: true });
};

beforeEach(() => {
  const store = useTabStore.getState();
  store.reset();
  store.switchWorkspace("acme"); // default /acme/issues tab
  store.openTab("/acme/chat?session=old", "", { activate: true });
  store.openTab("/acme/issues", "", { activate: true }); // back on Issues
});

describe("openExternalTarget", () => {
  it("lands on the exact target when an existing tab for that page is focused", () => {
    openExternalTarget("/acme/chat?session=new", pushViaOpenTab);
    expect(activeUrl()).toBe("/acme/chat?session=new");
  });

  it("keeps a plain navigation as is", () => {
    openExternalTarget("/acme/projects", pushViaOpenTab);
    expect(activeUrl()).toBe("/acme/projects");
  });

  it("does not rewrite a tab for a different page", () => {
    const pushNowhere = () => {};
    openExternalTarget("/acme/chat?session=new", pushNowhere);
    expect(activeUrl()).toBe("/acme/issues");
  });
});
