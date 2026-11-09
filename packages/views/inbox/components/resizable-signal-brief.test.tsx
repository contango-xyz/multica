import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResizableSignalBrief, SIGNAL_BRIEF_HEIGHT_KEY } from "./resizable-signal-brief";

vi.mock("../../i18n", () => ({
  useT: () => ({ t: () => "Resize summary panel" }),
}));

function setup({ brief = 100, container = 1000 } = {}) {
  render(
    <ResizableSignalBrief brief={<p>brief</p>}>
      <p>thread</p>
    </ResizableSignalBrief>,
  );
  const panel = screen.getByTestId("signal-brief-panel");
  const handle = screen.getByRole("separator");
  Object.defineProperty(panel, "offsetHeight", { configurable: true, value: brief });
  Object.defineProperty(panel.parentElement, "clientHeight", { configurable: true, value: container });
  return { panel, handle };
}

function drag(handle: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(handle, { button: 0, clientY: from, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: to, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientY: to, pointerId: 1 });
}

describe("ResizableSignalBrief", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the automatic height until someone drags", () => {
    const { panel } = setup();
    expect(panel.className).toContain("max-h-[40%]");
    expect(panel.style.height).toBe("");
  });

  it("follows a drag and saves the height", () => {
    const { panel, handle } = setup();
    drag(handle, 500, 650);
    expect(panel.style.height).toBe("250px");
    expect(panel.className).not.toContain("max-h-[40%]");
    expect(localStorage.getItem(SIGNAL_BRIEF_HEIGHT_KEY)).toBe("250");
  });

  it("stops at the minimum and at 80% of the space", () => {
    const { panel, handle } = setup();
    drag(handle, 500, 0);
    expect(panel.style.height).toBe("56px");
    drag(handle, 0, 5000);
    expect(panel.style.height).toBe("800px");
  });

  it("does not pin a height on a click without movement", () => {
    const { panel, handle } = setup();
    drag(handle, 500, 500);
    expect(panel.style.height).toBe("");
    expect(localStorage.getItem(SIGNAL_BRIEF_HEIGHT_KEY)).toBeNull();
  });

  it("restores the saved height and ignores a bad value", () => {
    localStorage.setItem(SIGNAL_BRIEF_HEIGHT_KEY, "320");
    expect(setup().panel.style.height).toBe("320px");
    document.body.innerHTML = "";
    localStorage.setItem(SIGNAL_BRIEF_HEIGHT_KEY, "nope");
    expect(setup().panel.style.height).toBe("");
  });

  it("goes back to automatic on double-click", () => {
    localStorage.setItem(SIGNAL_BRIEF_HEIGHT_KEY, "320");
    const { panel, handle } = setup();
    fireEvent.doubleClick(handle);
    expect(panel.style.height).toBe("");
    expect(localStorage.getItem(SIGNAL_BRIEF_HEIGHT_KEY)).toBeNull();
  });

  it("resizes from the keyboard", () => {
    const { panel, handle } = setup();
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(panel.style.height).toBe("124px");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(panel.style.height).toBe("100px");
  });
});
