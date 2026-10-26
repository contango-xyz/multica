import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "@multica/views/locales";

const openDesktopApp = vi.hoisted(() => vi.fn());

vi.mock("@/platform/desktop-handoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/desktop-handoff")>()),
  openDesktopApp,
}));

const KEY = "multica:open-links-in-desktop";

function setNavigationType(type: string | undefined) {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue(
    type === undefined ? [] : ([{ type }] as unknown as PerformanceEntryList),
  );
}

// The component hands off at most once per document via a module-level flag,
// so each test loads a fresh copy of the module.
async function renderHandoff() {
  const { DesktopHandoff } = await import("./desktop-handoff");
  return render(
    <I18nProvider locale="en" resources={RESOURCES}>
      <DesktopHandoff />
    </I18nProvider>,
  );
}

describe("DesktopHandoff", () => {
  beforeEach(() => {
    vi.resetModules();
    openDesktopApp.mockReset();
    localStorage.clear();
    window.history.replaceState(null, "", "/acme/issues/MUL-1?view=a#c-1");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hands the current path to the desktop app on a fresh navigation", async () => {
    localStorage.setItem(KEY, "true");
    setNavigationType("navigate");

    await renderHandoff();

    expect(openDesktopApp).toHaveBeenCalledTimes(1);
    expect(openDesktopApp).toHaveBeenCalledWith(
      "multica://open?path=%2Facme%2Fissues%2FMUL-1%3Fview%3Da%23c-1",
    );
    expect(
      screen.getByRole("region", { name: "Opened in the desktop app" }),
    ).toBeInTheDocument();
  });

  it.each(["reload", "back_forward", undefined])(
    "does not hand off when the navigation type is %s",
    async (type) => {
      localStorage.setItem(KEY, "true");
      setNavigationType(type);

      const { container } = await renderHandoff();

      expect(openDesktopApp).not.toHaveBeenCalled();
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("does not hand off when the setting is off", async () => {
    setNavigationType("navigate");

    const { container } = await renderHandoff();

    expect(openDesktopApp).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("hands off only once per document", async () => {
    localStorage.setItem(KEY, "true");
    setNavigationType("navigate");
    const { DesktopHandoff } = await import("./desktop-handoff");

    const first = render(
      <I18nProvider locale="en" resources={RESOURCES}>
        <DesktopHandoff />
      </I18nProvider>,
    );
    first.unmount();
    render(
      <I18nProvider locale="en" resources={RESOURCES}>
        <DesktopHandoff />
      </I18nProvider>,
    );

    expect(openDesktopApp).toHaveBeenCalledTimes(1);
  });

  it("does not hand off on a later mount after the setting is turned on", async () => {
    setNavigationType("navigate");
    const { DesktopHandoff } = await import("./desktop-handoff");

    const first = render(
      <I18nProvider locale="en" resources={RESOURCES}>
        <DesktopHandoff />
      </I18nProvider>,
    );
    first.unmount();
    localStorage.setItem(KEY, "true");
    render(
      <I18nProvider locale="en" resources={RESOURCES}>
        <DesktopHandoff />
      </I18nProvider>,
    );

    expect(openDesktopApp).not.toHaveBeenCalled();
  });

  it("Continue in browser hides the panel and keeps the setting", async () => {
    localStorage.setItem(KEY, "true");
    setNavigationType("navigate");
    await renderHandoff();

    await act(() =>
      userEvent.click(screen.getByRole("button", { name: "Continue in browser" })),
    );

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("true");
  });

  it("Stop opening links in the app turns the setting off and hides the panel", async () => {
    localStorage.setItem(KEY, "true");
    setNavigationType("navigate");
    await renderHandoff();

    await act(() =>
      userEvent.click(
        screen.getByRole("button", { name: "Stop opening links in the app" }),
      ),
    );

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("false");
  });
});
