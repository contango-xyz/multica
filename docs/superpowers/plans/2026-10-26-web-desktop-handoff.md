# Web → Desktop Link Handoff Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Links to our server that are opened in a browser (GitHub PR bodies, web Slack, email, bookmarks) open in the fork desktop app, without a browser extension and without changing the links themselves.

**Why not `multica://` links:** GitHub strips non-standard URL schemes from rendered Markdown, and such links break for anyone without the app (and on phones). Links stay `https://`; the web app hands off instead (the pattern Linear uses).

**Design**

- A per-browser web setting, **off by default**: "Open links in the desktop app" (Settings → Device → Desktop app). Stored in `localStorage` (web app layer; `packages/core` stays storage-agnostic).
- When the setting is on and a workspace page (`/{slug}/...`) is the **first page of a fresh navigation** — `PerformanceNavigationTiming.type === "navigate"`, not `reload` / `back_forward` — the web app sets `window.location.href = multica://open?path=<encodeURIComponent(pathname + search + hash)>` once, and shows a small panel over the page: "Opened in the desktop app", buttons **Continue in browser** (dismiss panel) and **Stop opening links in the app** (turn the setting off, dismiss). In-app (client-side) navigations never hand off: the check runs once per document load.
- The handoff runs before the auth/onboarding gates redirect, so the original path is what gets handed over even when the browser session is logged out.
- Desktop (fork build): `handleDeepLink` accepts `multica://open?path=<path>`. The path must start with exactly one `/` (reject `//…`, absolute URLs, empty) and must not be a focus-only path (`/`, `/login`, `/desktop/*`, `/api/*` — the same rule as `decideWebLink`). Valid → `route:open` with the path and focus the main window; invalid → focus only. Cold start and pre-ready queueing reuse the existing deep-link path.
- A stock (upstream) desktop app ignores `multica://open` and just comes forward; the "Continue in browser" button covers that and the no-app case.

**Global constraints:** public repo (no internal hosts/ids); upstream behaviour unchanged with the setting off; all five locales get the new strings (`packages/views/locales/parity.test.ts`); AGENTS.md package boundaries (no `next/*` in views, no storage in core); copy follows the UI copy rules (no descriptions restating labels).

---

### Task A: Desktop handles `multica://open?path=`

**Files:** `apps/desktop/src/main/web-link.ts` (export a path-level helper reused by `decideWebLink`, e.g. `decideAppPath(path): WebLinkDecision` → `route` | `focus`), `apps/desktop/src/main/index.ts` (`handleDeepLink`), tests in `apps/desktop/src/main/web-link.test.ts`.

- Tests first: `decideAppPath` accepts `/acme/issues/abc?x=1#c`; focuses for `/`, `/login`, `/desktop/x`, `/api/x`, `//evil.test/x`, `https://evil.test/x`, `""`, `acme/issues` (no leading slash). `decideWebLink` behaviour unchanged (existing tests stay green).
- `handleDeepLink`: `parsed.hostname === "open"` → `decideAppPath(parsed.searchParams.get("path") ?? "")` → `route` → `dispatchToMainRenderer("route:open", path)` + focus main window (the same focus helper `handleWebLink` uses); `focus` → focus only.
- Commit: `feat(desktop): open multica://open?path= links in the app (contango)`.

### Task B: Web handoff + setting

**Files (create):** `apps/web/platform/desktop-handoff.ts` (pure helpers + storage), `apps/web/platform/desktop-handoff.test.ts`, `apps/web/components/desktop-handoff.tsx` (or the closest existing web components folder; match conventions), its test; **modify:** `apps/web/app/[workspaceSlug]/layout.tsx` (mount the handoff first), `apps/web/app/[workspaceSlug]/(dashboard)/settings/page.tsx` (pass `extraDeviceTabs` with a "Desktop app" tab holding the switch), `packages/views/locales/*/settings.json` (strings, all five locales).

- Pure helpers (unit-tested, `// @vitest-environment node` where DOM-free):
  - `handoffUrl(pathname, search, hash): string` → `multica://open?path=...` (encoded).
  - `shouldHandOff({ enabled, navigationType, alreadyHandled }): boolean` → only `enabled && navigationType === "navigate" && !alreadyHandled`.
  - `readOpenInDesktop(): boolean` / `writeOpenInDesktop(v: boolean)` — `localStorage` key `multica:open-links-in-desktop`, every access in try/catch (private mode), default `false`.
- Component: reads the navigation type via `performance.getEntriesByType("navigation")[0]?.type` (missing → treat as not "navigate"), hands off at most once per document (module-level flag), renders the panel only after a handoff. Component tests: hands off when enabled + navigate; not on reload / back_forward / disabled; "Stop opening links in the app" writes `false`; "Continue in browser" hides the panel. Use the shared UI primitives (`packages/ui/docs/button.md`).
- Settings tab: a single switch with the label; no description paragraph.
- Commit: `feat(web): hand workspace links to the desktop app when enabled (contango)`.

### Task C: Docs

- `docs/contango/desktop-release.md`: "Opening links in the app" — turn the web setting on in each browser; the Choosy rule is optional (still useful for links from native apps such as Slack desktop or Mail).
- `docs/contango/PATCHES.md`: extend entry 11 (desktop build) with the web handoff files.
- Commit: `docs(contango): web link handoff`.
