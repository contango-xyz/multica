"use client";

import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { defaultStorage } from "@multica/core/platform";
import { useT } from "../../i18n";
import { cn } from "@multica/ui/lib/utils";

/** One saved height per browser: it's how the reader likes this panel, not a per-card fact. */
export const SIGNAL_BRIEF_HEIGHT_KEY = "multica_inbox_signal_brief_height";

const MIN_HEIGHT = 56;
const MAX_SHARE = 0.8;
const KEYBOARD_STEP = 24;

function readSavedHeight(): number | null {
  const raw = defaultStorage.getItem(SIGNAL_BRIEF_HEIGHT_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= MIN_HEIGHT ? value : null;
}

/**
 * The signal brief above the issue thread, with a drag handle on its lower edge.
 *
 * Until someone drags it, the brief keeps its automatic height (its content, up
 * to 40%), so a one-line brief doesn't reserve empty space. Dragging pins an
 * explicit height, saved for next time; double-clicking the handle goes back to
 * automatic. The saved height is capped in CSS as well as during the drag, so
 * shrinking the window can't push the thread off screen.
 */
export function ResizableSignalBrief({
  brief,
  children,
}: {
  brief: ReactNode;
  children: ReactNode;
}) {
  const { t } = useT("inbox");
  const containerRef = useRef<HTMLDivElement>(null);
  const briefRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(null);
  const [height, setHeight] = useState<number | null>(readSavedHeight);

  const clamp = useCallback((next: number) => {
    const available = containerRef.current?.clientHeight ?? 0;
    const max = available > 0 ? Math.max(MIN_HEIGHT, available * MAX_SHARE) : Number.POSITIVE_INFINITY;
    return Math.round(Math.min(max, Math.max(MIN_HEIGHT, next)));
  }, []);

  const apply = (next: number) => {
    const clamped = clamp(next);
    setHeight(clamped);
    return clamped;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      startY: event.clientY,
      startHeight: briefRef.current?.offsetHeight ?? 0,
      moved: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || (!drag.moved && event.clientY === drag.startY)) return;
    drag.moved = true;
    apply(drag.startHeight + event.clientY - drag.startY);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    // A click without movement mustn't turn automatic height into a fixed one.
    if (!drag.moved) return;
    const saved = apply(drag.startHeight + event.clientY - drag.startY);
    defaultStorage.setItem(SIGNAL_BRIEF_HEIGHT_KEY, String(saved));
  };

  const reset = () => {
    dragRef.current = null;
    setHeight(null);
    defaultStorage.removeItem(SIGNAL_BRIEF_HEIGHT_KEY);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const current = height ?? briefRef.current?.offsetHeight ?? 0;
    const saved = apply(current + direction * KEYBOARD_STEP);
    defaultStorage.setItem(SIGNAL_BRIEF_HEIGHT_KEY, String(saved));
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      <div
        ref={briefRef}
        data-testid="signal-brief-panel"
        className={cn("shrink-0 overflow-y-auto px-6 py-3", height === null && "max-h-[40%]")}
        style={height === null ? undefined : { height, maxHeight: `${MAX_SHARE * 100}%` }}
      >
        {brief}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t(($) => $.smart.resize_brief)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
        className="group flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center border-b outline-none hover:bg-accent focus-visible:bg-accent [@media(pointer:coarse)]:h-5"
      >
        <span className="h-0.5 w-8 rounded-full bg-border group-hover:bg-muted-foreground group-focus-visible:bg-muted-foreground" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
