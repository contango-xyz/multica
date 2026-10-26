import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "@multica/views/locales";
import { OpenInDesktopSetting } from "./open-in-desktop-setting";

const KEY = "multica:open-links-in-desktop";

describe("OpenInDesktopSetting", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is off by default and persists the switch", async () => {
    render(
      <I18nProvider locale="en" resources={RESOURCES}>
        <OpenInDesktopSetting />
      </I18nProvider>,
    );

    const toggle = screen.getByRole("switch", {
      name: "Open links in the desktop app",
    });
    expect(toggle).not.toBeChecked();

    await act(() => userEvent.click(toggle));

    expect(toggle).toBeChecked();
    expect(localStorage.getItem(KEY)).toBe("true");
  });
});
