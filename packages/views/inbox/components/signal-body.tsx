"use client";

// Contango patch 51 (owner 2026-11-17): a signal's body is Markdown, rendered by
// the product renderer comments use, so `[CTG-N](mention://issue/<uuid>)` shows
// Multica's issue chip (status icon, id, title; live status, hover card) and
// links open in the app. The feeders' plain-text bodies render as before
// (line breaks kept: RichContent's remark-breaks).

import { cn } from "@multica/ui/lib/utils";
import { RichContent } from "../../rich-content";

export function SignalBody({ body, className }: { body: string; className?: string }) {
  return (
    <div data-testid="signal-body" className="min-w-0">
      <RichContent content={body} density="compact" className={cn("break-words", className)} />
    </div>
  );
}
