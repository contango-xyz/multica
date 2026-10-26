# Fork Desktop Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed, notarized fork build of the Multica desktop app that gets APNs pushes (also when quit), opens the right screen on click, opens our server's web links, and self-updates from a feed on our server.

**Architecture:** The server already pushes to iOS; it learns a second platform (`macos`). The desktop main process registers with APNs through Electron's `pushNotifications`, the renderer reports the token through the existing `/api/push/devices` API, and push clicks reuse the existing main→renderer routing. Packaging becomes fork-specific through a git-ignored env file read by one build script, so no Contango identifiers land in the public repo.

**Tech Stack:** Go (server), Electron 39 + electron-builder 26 + electron-updater 6, React/TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-desktop-build-design.md`

## Global Constraints

- Public repo: no internal hostnames, Apple team id or Contango bundle ids in committed files. They live in `apps/desktop/.env.contango.local` (git-ignored by the root `.env*` rule).
- Bundle id is ours, not `ai.multica.desktop`. Product name stays "Multica".
- APNs environment for the desktop is always `production` (Developer ID builds).
- macOS arm64 only.
- Versions are `<upstream>-contango.<n>`, taken from a `v<upstream>-contango.<n>` git tag; update channel `contango`.
- Builds run on the owner's Mac; the certificate never goes to CI.
- Server migrations: no foreign keys; index migrations use `CONCURRENTLY` (not needed here).
- Branch: `contango/desktop-build`, on top of `contango/push-rich-text` (what ops runs).

## Review Focus

1. **Logout on a shared Mac.** After logout the Mac must stop getting the old user's pushes: unregister must reach the server *before* the API token is cleared (Task 4 test pins header capture).
2. **App already running when a push is clicked.** Expect the item to open, not just app activation. Depends on Electron delivering the click (Task 7 spike decides; the degraded behaviour is defined there).
3. **Duplicate banners.** App running in the background + push registered → exactly one banner (Task 6 suppression test).
4. **Foreign links handed over by Choosy.** A non-server `https` URL must go to the default browser, never load inside the app (Task 8 test).
5. **Push for another workspace.** Clicking a push from workspace B while A is open must open B's inbox item (Task 5 mapping uses the payload's `workspace_slug`, test included).

---

### Task 1: Server accepts macOS devices

**Files:**
- Numbering: fork migrations go after upstream's highest (docs/contango/PATCHES.md). 594 was
  free on 2026-10-26 (upstream main tops out at 593). Re-check `ls server/migrations` against
  `origin/main` before creating, and take the next free number if upstream has moved.
- Create: `server/migrations/594_push_device_platform_macos.up.sql`, `server/migrations/594_push_device_platform_macos.down.sql`
- Modify: `server/internal/handler/push_device.go` (platform switch, ~line 39)
- Test: `server/internal/handler/push_device_test.go`

**Interfaces:**
- Produces: `POST /api/push/devices` accepts `platform: "ios" | "macos"`.

- [ ] **Step 1: Write the failing test** — add to `push_device_test.go`:

```go
func TestRegisterPushDeviceAcceptsMacOS(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	resetPushDevices(t)
	body := map[string]any{"platform": "macos", "token": "tok-mac", "bundle_id": "com.example.desktop", "environment": "production"}
	if code := registerPush(t, testUserID, body); code != http.StatusNoContent && code != http.StatusOK && code != http.StatusCreated {
		t.Fatalf("status = %d, want success", code)
	}
	owner, disabled := pushOwner(t, "tok-mac")
	if owner != testUserID || disabled {
		t.Fatalf("owner=%q disabled=%v", owner, disabled)
	}
}
```

Check the success status the existing iOS register test expects and use exactly that one instead of the three-way check.

- [ ] **Step 2: Run it** — `cd server && set -a && . ../.env && set +a && go test ./internal/handler/ -run TestRegisterPushDevice -count=1`. Expected: FAIL, 400 "platform must be ios".

- [ ] **Step 3: Migration**

`594_push_device_platform_macos.up.sql`:
```sql
-- The fork desktop app registers APNs tokens too.
ALTER TABLE push_device DROP CONSTRAINT IF EXISTS push_device_platform_check;
ALTER TABLE push_device ADD CONSTRAINT push_device_platform_check CHECK (platform IN ('ios', 'macos'));
```
`594_push_device_platform_macos.down.sql`:
```sql
DELETE FROM push_device WHERE platform = 'macos';
ALTER TABLE push_device DROP CONSTRAINT IF EXISTS push_device_platform_check;
ALTER TABLE push_device ADD CONSTRAINT push_device_platform_check CHECK (platform IN ('ios'));
```

- [ ] **Step 4: Handler** — in `push_device.go` replace the platform case:

```go
	case req.Platform != "ios" && req.Platform != "macos":
		writeError(w, http.StatusBadRequest, "platform must be ios or macos")
		return
```

- [ ] **Step 5: Migrate + test** — `make migrate-up` from the repo root, then rerun Step 2. Expected: PASS, and the existing `"platform": "android"` case still returns 400.

- [ ] **Step 6: Commit** — `feat(server): accept macOS push devices`.

---

### Task 2: Owner's Apple setup (manual, owner)

Not code. The executor gives the owner this checklist and waits.

- [ ] In developer.apple.com (Distributed Consulting team): Identifiers → new App ID, bundle id `<reverse-domain>.multica.desktop`, capability **Push Notifications**.
- [ ] Certificates → **Developer ID Application** (Xcode → Settings → Accounts → Manage Certificates → + is quickest). It must show in `security find-identity -v -p codesigning` as `Developer ID Application: … (<TEAM>)`.
- [ ] Profiles → **Developer ID** profile for that App ID → download to `~/Developer/multica-desktop-signing/desktop.provisionprofile`.
- [ ] Notarization credentials: `xcrun notarytool store-credentials multica-notary --apple-id <apple id> --team-id <TEAM>` (prompts for an app-specific password from appleid.apple.com).
- [ ] Create `apps/desktop/.env.contango.local`:

```sh
CONTANGO_APP_ID=<reverse-domain>.multica.desktop
CONTANGO_TEAM_ID=<TEAM>
CONTANGO_PROVISIONING_PROFILE=/Users/<you>/Developer/multica-desktop-signing/desktop.provisionprofile
CONTANGO_API_URL=https://<server host>
CONTANGO_UPDATE_URL=https://<server host>/desktop/
APPLE_KEYCHAIN_PROFILE=multica-notary
```

- [ ] Verify: `git status --ignored apps/desktop/.env.contango.local` lists it as ignored.

---

### Task 3: Fork packaging (sign, entitlements, profile, notarize, feed, default server)

**Files:**
- Create: `apps/desktop/scripts/contango-build.mjs`, `apps/desktop/build/entitlements.contango.template.plist`
- Modify: `apps/desktop/src/shared/runtime-config.ts` (default config), `apps/desktop/electron.vite.config.ts` (define), `apps/desktop/src/main/updater.ts` (channel)
- Test: `apps/desktop/src/shared/runtime-config.test.ts` (existing file; add a case), `apps/desktop/scripts/contango-build.test.mjs`

**Interfaces:**
- Produces: `pnpm --filter @multica/desktop contango:build [--publish]` → `apps/desktop/dist/mac-arm64/` with DMG, ZIP, blockmap, `contango-mac.yml`.
- Produces: build-time constant `__CONTANGO_API_URL__` (string, `""` when unset).

- [ ] **Step 1: Failing tests.** In `runtime-config.test.ts`:

```ts
it("uses the build-time server URL as default when set", () => {
  expect(defaultRuntimeConfigFor("https://srv.example.test")).toEqual({
    schemaVersion: 1,
    apiUrl: "https://srv.example.test",
    wsUrl: "wss://srv.example.test/ws",
    appUrl: "https://srv.example.test",
  });
});
it("keeps upstream defaults without a build-time URL", () => {
  expect(defaultRuntimeConfigFor("")).toEqual(DEFAULT_RUNTIME_CONFIG_UPSTREAM);
});
```

In `contango-build.test.mjs` (node test runner like `package.test.mjs`):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEntitlements, builderOverrides } from "./contango-build.mjs";

const env = {
  CONTANGO_APP_ID: "com.example.desktop", CONTANGO_TEAM_ID: "ABCDE12345",
  CONTANGO_PROVISIONING_PROFILE: "/tmp/p.provisionprofile",
  CONTANGO_API_URL: "https://srv.example.test", CONTANGO_UPDATE_URL: "https://srv.example.test/desktop/",
};

test("entitlements carry push + identity", () => {
  const xml = renderEntitlements("<dict>{{APP_IDENTIFIER}}|{{TEAM_ID}}</dict>", env);
  assert.equal(xml, "<dict>ABCDE12345.com.example.desktop|ABCDE12345</dict>");
});

test("overrides point at our id, profile and feed", () => {
  const o = builderOverrides(env, "/tmp/ent.plist");
  assert.equal(o.appId, "com.example.desktop");
  assert.equal(o.mac.provisioningProfile, "/tmp/p.provisionprofile");
  assert.equal(o.mac.entitlements, "/tmp/ent.plist");
  assert.deepEqual(o.publish, { provider: "generic", url: "https://srv.example.test/desktop/", channel: "contango" });
});

test("missing variable fails loudly", () => {
  assert.throws(() => builderOverrides({ ...env, CONTANGO_APP_ID: "" }, "/tmp/e"), /CONTANGO_APP_ID/);
});
```

- [ ] **Step 2: Run** — `cd apps/desktop && pnpm vitest run src/shared/runtime-config.test.ts && node --test scripts/contango-build.test.mjs`. Expected: FAIL (missing exports).

- [ ] **Step 3: Runtime default.** In `runtime-config.ts` rename the current constant to `DEFAULT_RUNTIME_CONFIG_UPSTREAM`, add:

```ts
declare const __CONTANGO_API_URL__: string;

// Fork builds bake their server in (see scripts/contango-build.mjs) so a
// fresh install needs no ~/.multica/desktop.json. The file still wins.
export function defaultRuntimeConfigFor(apiUrl: string): RuntimeConfig {
  if (!apiUrl) return DEFAULT_RUNTIME_CONFIG_UPSTREAM;
  const base = apiUrl.replace(/\/+$/, "");
  return Object.freeze({
    schemaVersion: 1,
    apiUrl: base,
    wsUrl: `${base.replace(/^http/, "ws")}/ws`,
    appUrl: base,
  });
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = defaultRuntimeConfigFor(
  typeof __CONTANGO_API_URL__ === "string" ? __CONTANGO_API_URL__ : "",
);
```

In `electron.vite.config.ts` add to the `main`, `preload` and `renderer` sections' `define`:
```ts
__CONTANGO_API_URL__: JSON.stringify(process.env.CONTANGO_API_URL ?? ""),
```
(The vitest config needs the same define, or tests fall back through the `typeof` guard; keep the guard.)

- [ ] **Step 4: Entitlements template** `build/entitlements.contango.template.plist` = copy of `build/entitlements.mac.plist` plus, before `</dict>`:

```xml
  <!-- Fork build: APNs + the identity the provisioning profile grants. -->
  <key>com.apple.developer.aps-environment</key>
  <string>production</string>
  <key>com.apple.application-identifier</key>
  <string>{{APP_IDENTIFIER}}</string>
  <key>com.apple.developer.team-identifier</key>
  <string>{{TEAM_ID}}</string>
```

- [ ] **Step 5: Build script** `scripts/contango-build.mjs`:

```js
#!/usr/bin/env node
// Fork-only: builds, signs and notarizes the Contango desktop app from the
// git-ignored .env.contango.local. Upstream's scripts/package.mjs is untouched.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["CONTANGO_APP_ID", "CONTANGO_TEAM_ID", "CONTANGO_PROVISIONING_PROFILE", "CONTANGO_API_URL", "CONTANGO_UPDATE_URL"];

export function renderEntitlements(template, env) {
  return template
    .replaceAll("{{APP_IDENTIFIER}}", `${env.CONTANGO_TEAM_ID}.${env.CONTANGO_APP_ID}`)
    .replaceAll("{{TEAM_ID}}", env.CONTANGO_TEAM_ID);
}

export function builderOverrides(env, entitlementsPath) {
  for (const k of REQUIRED) if (!env[k]) throw new Error(`${k} missing from .env.contango.local`);
  return {
    appId: env.CONTANGO_APP_ID,
    mac: { entitlements: entitlementsPath, provisioningProfile: env.CONTANGO_PROVISIONING_PROFILE, notarize: true },
    publish: { provider: "generic", url: env.CONTANGO_UPDATE_URL, channel: "contango" },
  };
}

function loadEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function main() {
  const env = { ...process.env, ...loadEnvFile(join(desktopRoot, ".env.contango.local")) };
  const version = execFileSync("git", ["describe", "--tags", "--match", "v*-contango.*", "--exact-match"], { cwd: desktopRoot })
    .toString().trim().replace(/^v/, "");
  const dir = mkdtempSync(join(tmpdir(), "multica-contango-"));
  const entitlements = join(dir, "entitlements.plist");
  writeFileSync(entitlements, renderEntitlements(readFileSync(join(desktopRoot, "build/entitlements.contango.template.plist"), "utf8"), env));
  const o = builderOverrides(env, entitlements);
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: desktopRoot, stdio: "inherit", env });
  run("pnpm", ["run", "build"]);
  run("pnpm", ["exec", "electron-builder", "--mac", "--arm64", "--publish", "never",
    `-c.extraMetadata.version=${version}`,
    `-c.appId=${o.appId}`,
    `-c.mac.entitlements=${o.mac.entitlements}`,
    `-c.mac.provisioningProfile=${o.mac.provisioningProfile}`,
    `-c.publish.provider=generic`, `-c.publish.url=${o.publish.url}`, `-c.publish.channel=contango`,
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

Requires an exact `v<upstream>-contango.<n>` tag on HEAD, so every published build is reproducible from a tag. Add to `package.json` scripts: `"contango:build": "node scripts/contango-build.mjs"`.

- [ ] **Step 6: Updater channel.** In `updater.ts`, after `configureMacX64UpdateChannel(autoUpdater);`:

```ts
// Fork builds publish to the "contango" channel of a generic feed; pinning it
// keeps prerelease versions (x.y.z-contango.n) on our feed only.
if (app.getVersion().includes("-contango.")) {
  autoUpdater.channel = "contango";
  autoUpdater.allowDowngrade = false;
}
```

- [ ] **Step 7: Run tests** — Step 2 commands. Expected: PASS. Also `pnpm --filter @multica/desktop typecheck`.

- [ ] **Step 8: Real build.** `git tag v0.7.0-contango.1 && pnpm --filter @multica/desktop contango:build`. Then verify:
  - `codesign -dv --entitlements - dist/mac-arm64/Multica.app 2>&1 | grep -E "Authority=Developer ID|aps-environment|TeamIdentifier"` → all three present.
  - `spctl -a -vv dist/mac-arm64/Multica.app` → `accepted`, `source=Notarized Developer ID`.
  - `ls dist/` shows the DMG, ZIP, `.blockmap` and `contango-mac.yml`; `grep version dist/contango-mac.yml` → `0.7.0-contango.1`.
  - `strings dist/mac-arm64/Multica.app/Contents/Resources/app.asar | grep -c "$CONTANGO_API_URL"` ≥ 1.
  Do not push the tag yet.

- [ ] **Step 9: Commit** — `feat(desktop): fork packaging — own app id, push entitlement, notarized, generic update feed`.

---

### Task 4: Core API + logout hook for push devices

**Files:**
- Modify: `packages/core/api/client.ts` (near `markInboxRead`), `packages/core/auth/store.ts` (`logout`), `packages/core/platform/core-provider.tsx` (pass-through)
- Test: `packages/core/api/client.test.ts`, `packages/core/auth/store.test.ts` (create if absent, `// @vitest-environment node`)

**Interfaces:**
- Produces: `api.registerPushDevice(body: { platform: "macos"; token: string; bundle_id: string; environment: "production" }): Promise<void>`
- Produces: `api.unregisterPushDevice(token: string): Promise<void>`
- Produces: `createAuthStore({ ..., beforeLogout?: () => void })` and `CoreProvider` prop `beforeLogout`. Called synchronously at the start of `logout()`, before the token is cleared. Not called on session expiry (the credential is dead; server-side token reuse covers it).

- [ ] **Step 1: Failing tests.** Client (mirror `apps/mobile/data/api.test.ts` lines ~110–130):

```ts
it("registers a push device", async () => {
  const body = { platform: "macos" as const, token: "t", bundle_id: "b", environment: "production" as const };
  await client.registerPushDevice(body);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(`${BASE}/api/push/devices`);
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual(body);
});
it("unregisters by token and sends the auth header even if the token is cleared right after", async () => {
  client.setToken("jwt-1");
  const p = client.unregisterPushDevice("a/b");
  client.setToken(null);
  await p;
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(`${BASE}/api/push/devices/a%2Fb`);
  expect(init.method).toBe("DELETE");
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer jwt-1");
});
```

Use the file's existing `fetchMock`/`BASE`/client setup names.

Store:
```ts
it("runs beforeLogout before clearing the token", () => {
  const order: string[] = [];
  const api = { setToken: (t: string | null) => order.push(`setToken:${t}`), logout: async () => {} } as never;
  const store = createAuthStore({ api, storage: memoryStorage(), beforeLogout: () => order.push("before") });
  store.getState().logout();
  expect(order[0]).toBe("before");
  expect(order).toContain("setToken:null");
});
```
Build `memoryStorage()` the way other core auth tests do (grep `createAuthStore(` in `packages/core` tests and copy its options).

- [ ] **Step 2: Run** — `pnpm --filter @multica/core vitest run api/client.test.ts auth/store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `client.ts`:

```ts
  // Native push device tokens (fork: macOS desktop). Same endpoint as mobile.
  async registerPushDevice(body: {
    platform: "macos";
    token: string;
    bundle_id: string;
    environment: "production";
  }): Promise<void> {
    await this.fetch<void>("/api/push/devices", { method: "POST", body: JSON.stringify(body) });
  }

  async unregisterPushDevice(token: string): Promise<void> {
    await this.fetch<void>(`/api/push/devices/${encodeURIComponent(token)}`, { method: "DELETE" });
  }
```

If the header test fails because `fetchRaw` awaits before building headers, capture `const auth = this.authHeaders()` synchronously in `unregisterPushDevice` and pass it as `headers`.

`store.ts`: add `beforeLogout?: () => void;` to the options type with a one-line doc ("runs before the credential is cleared, e.g. to unregister a push device"), destructure it, and make `logout` start with `beforeLogout?.();`. `core-provider.tsx`: add the prop and pass it through to `createAuthStore` next to `onLogout`.

- [ ] **Step 4: Run tests** — Expected: PASS. `pnpm --filter @multica/core typecheck`.

- [ ] **Step 5: Commit** — `feat(core): push device API and a beforeLogout hook`.

---

### Task 5: Main process push module (register, payload → route, clicks)

**Files:**
- Create: `apps/desktop/src/main/push.ts`
- Modify: `apps/desktop/src/main/index.ts` (wire-up), `apps/desktop/src/shared/main-renderer-messages.ts` (add `"route:open"`), `apps/desktop/src/preload/index.ts` + `index.d.ts`
- Test: `apps/desktop/src/main/push.test.ts`

**Interfaces:**
- Produces: `routeForPushPayload(userInfo: unknown): PushRoute | null` where
  `type PushRoute = { kind: "inbox"; slug: string; itemId: string; issueKey: string } | { kind: "chat"; slug: string; sessionId: string }`.
  Reads `userInfo.body` (the server puts routing data under `body`): `kind`, `workspace_slug`, `item_id`, `issue_id`, `session_id`.
- Produces IPC: `ipcMain.handle("push:register")` → `Promise<{ token: string } | { error: string }>` (macOS only; other platforms `{ error: "unsupported" }`).
- Produces preload: `desktopAPI.registerPush(): Promise<{ token: string } | { error: string }>`, `desktopAPI.setPushActive(active: boolean): void`, `desktopAPI.onRouteOpen(cb: (path: string) => void): () => void`.
- Inbox routes reuse the existing `"inbox:open"` channel; chat routes use new `"route:open"` with `paths.workspace(slug).chatSession(id)`.

- [ ] **Step 1: Failing tests** `push.test.ts` (`// @vitest-environment node`):

```ts
import { describe, expect, it } from "vitest";
import { routeForPushPayload } from "./push";

describe("routeForPushPayload", () => {
  it("routes inbox pushes to the issue in their own workspace", () => {
    expect(routeForPushPayload({ aps: {}, body: { kind: "inbox", workspace_slug: "b", item_id: "i1", issue_id: "is1" } }))
      .toEqual({ kind: "inbox", slug: "b", itemId: "i1", issueKey: "is1" });
  });
  it("falls back to the item id without an issue", () => {
    expect(routeForPushPayload({ body: { kind: "inbox", workspace_slug: "b", item_id: "i1" } }))
      .toEqual({ kind: "inbox", slug: "b", itemId: "i1", issueKey: "i1" });
  });
  it("routes chat pushes to the session", () => {
    expect(routeForPushPayload({ body: { kind: "chat", workspace_slug: "b", session_id: "s1" } }))
      .toEqual({ kind: "chat", slug: "b", sessionId: "s1" });
  });
  it.each([null, {}, { body: {} }, { body: { kind: "inbox", item_id: "i1" } }, { body: { kind: "x", workspace_slug: "b" } }])(
    "rejects %j", (v) => expect(routeForPushPayload(v)).toBeNull());
});
```

- [ ] **Step 2: Run** — `cd apps/desktop && pnpm vitest run src/main/push.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `push.ts`:**

```ts
import { pushNotifications } from "electron";

export type PushRoute =
  | { kind: "inbox"; slug: string; itemId: string; issueKey: string }
  | { kind: "chat"; slug: string; sessionId: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : "");

// Routing data from the server's APNs payload (`body`, see server/internal/push).
export function routeForPushPayload(userInfo: unknown): PushRoute | null {
  const body = (userInfo as { body?: Record<string, unknown> } | null)?.body;
  if (!body || typeof body !== "object") return null;
  const slug = str(body.workspace_slug);
  if (!slug) return null;
  if (body.kind === "inbox") {
    const itemId = str(body.item_id);
    if (!itemId) return null;
    return { kind: "inbox", slug, itemId, issueKey: str(body.issue_id) || itemId };
  }
  if (body.kind === "chat") {
    const sessionId = str(body.session_id);
    return sessionId ? { kind: "chat", slug, sessionId } : null;
  }
  return null;
}

export async function registerForPush(): Promise<{ token: string } | { error: string }> {
  if (process.platform !== "darwin") return { error: "unsupported" };
  try {
    return { token: await pushNotifications.registerForAPNSNotifications() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Wire in `index.ts`:**
  - Add `"route:open"` to `MAIN_RENDERER_MESSAGE_CHANNELS`.
  - A helper next to the existing `notification:show` handler:
    ```ts
    function openPushRoute(route: PushRoute | null): void {
      if (!route) return; // no payload: the app just comes forward (Task 7 decides if that needs more)
      if (route.kind === "inbox") {
        dispatchToMainRenderer("inbox:open", { slug: route.slug, itemId: route.itemId, issueKey: route.issueKey });
      } else {
        dispatchToMainRenderer("route:open", paths.workspace(route.slug).chatSession(route.sessionId));
      }
    }
    ```
    (Import `paths` from `@multica/core/paths` if main already may; otherwise build `` `/${slug}/chat?session=${encodeURIComponent(id)}` `` inline and note it mirrors `paths.chatSession`.)
  - Cold launch: change `app.whenReady().then(async () => {` to also capture launch info — register before it, at top level: `app.once("ready", (_e, launchInfo) => { pendingLaunchRoute = routeForPushPayload((launchInfo as { userInfo?: unknown })?.userInfo ?? launchInfo); });` and call `openPushRoute(pendingLaunchRoute)` once the main renderer exists (dispatchToMainRenderer already queues until the listener is ready).
  - Running: `pushNotifications.on("received-apns-notification", (_e, userInfo) => { lastPushRoute = routeForPushPayload(userInfo); });` — kept for Task 7's decision; no navigation on receipt.
  - `ipcMain.handle("push:register", () => registerForPush());`
  - `ipcMain.on("push:active", (_e, active: unknown) => { pushActive = active === true; });` (used in Task 6).
- [ ] **Step 5: Preload** — add to `desktopAPI` in `preload/index.ts` and its `.d.ts`:
  ```ts
  registerPush: () => ipcRenderer.invoke("push:register") as Promise<{ token: string } | { error: string }>,
  setPushActive: (active: boolean) => ipcRenderer.send("push:active", active),
  onRouteOpen: (callback: (path: string) => void) => subscribeToMainRendererChannel("route:open", callback),
  ```
- [ ] **Step 6: Run tests + typecheck** — `pnpm vitest run src/main/push.test.ts && pnpm --filter @multica/desktop typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** — `feat(desktop): APNs registration and push click routing in main`.

---

### Task 6: Renderer push bridge + no duplicate banners + click retention fix

**Files:**
- Create: `apps/desktop/src/renderer/src/components/desktop-push-bridge.tsx`
- Modify: `apps/desktop/src/renderer/src/components/desktop-layout.tsx` (mount bridge, handle `onRouteOpen`), `apps/desktop/src/renderer/src/App.tsx` (pass `beforeLogout`), `apps/desktop/src/main/index.ts` (`notification:show`), `apps/desktop/src/main/notification-gate.ts`
- Test: `apps/desktop/src/renderer/src/components/desktop-push-bridge.test.tsx`, `apps/desktop/src/main/notification-gate.test.ts`

**Interfaces:**
- Consumes: Task 4 `api.registerPushDevice/unregisterPushDevice`, `beforeLogout`; Task 5 `desktopAPI.registerPush/setPushActive/onRouteOpen`.
- Produces: `NotificationGate.shouldShow(itemId, anyWindowFocused, pushActive)` (third arg; `true` → never show) and `retainNotification(n: { once(e: "click" | "close", cb: () => void): unknown }): void` exported from `notification-gate.ts`.
- Bundle id at runtime: main exposes nothing new; the renderer sends `bundle_id` from a build-time define `__CONTANGO_APP_ID__` added the same way as `__CONTANGO_API_URL__` in Task 3 (add it to `contango-build.mjs` env and `electron.vite.config.ts`). If it is empty (upstream build), the bridge does nothing.

- [ ] **Step 1: Failing tests.**

`notification-gate.test.ts` additions:
```ts
it("never shows a local banner while push is active", () => {
  const gate = new NotificationGate();
  expect(gate.shouldShow("a", false, true)).toBe(false);
});
it("retains a notification until clicked or closed", () => {
  const handlers: Record<string, () => void> = {};
  const n = { once: (e: "click" | "close", cb: () => void) => { handlers[e] = cb; return n; } };
  retainNotification(n);
  expect(retainedNotificationCount()).toBe(1);
  handlers.click!();
  expect(retainedNotificationCount()).toBe(0);
});
```

`desktop-push-bridge.test.tsx` (mock `@multica/core/api` per AGENTS.md):
```tsx
vi.mock("@multica/core/api", () => ({ api: { registerPushDevice: vi.fn(async () => {}), unregisterPushDevice: vi.fn(async () => {}) } }));

it("registers the APNs token with the server and turns local banners off", async () => {
  window.desktopAPI = { ...window.desktopAPI, registerPush: vi.fn(async () => ({ token: "tok" })), setPushActive: vi.fn() };
  render(<DesktopPushBridge appId="com.example.desktop" />);
  await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledWith({ platform: "macos", token: "tok", bundle_id: "com.example.desktop", environment: "production" }));
  expect(window.desktopAPI.setPushActive).toHaveBeenCalledWith(true);
});
it("keeps local banners when registration fails", async () => {
  window.desktopAPI = { ...window.desktopAPI, registerPush: vi.fn(async () => ({ error: "denied" })), setPushActive: vi.fn() };
  render(<DesktopPushBridge appId="com.example.desktop" />);
  await waitFor(() => expect(window.desktopAPI.registerPush).toHaveBeenCalled());
  expect(api.registerPushDevice).not.toHaveBeenCalled();
  expect(window.desktopAPI.setPushActive).not.toHaveBeenCalledWith(true);
});
it("does nothing on an upstream build", () => {
  window.desktopAPI = { ...window.desktopAPI, registerPush: vi.fn() };
  render(<DesktopPushBridge appId="" />);
  expect(window.desktopAPI.registerPush).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run** — `cd apps/desktop && pnpm vitest run src/main/notification-gate.test.ts src/renderer/src/components/desktop-push-bridge.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Gate + retention** in `notification-gate.ts`:

```ts
  shouldShow(itemId: string, anyWindowFocused: boolean, pushActive = false): boolean {
    if (pushActive) return false; // APNs already shows this one
    // ...existing body unchanged
  }

// An Electron Notification that gets garbage collected loses its click
// handler; macOS then only activates the app. Hold each one until it ends.
const retained = new Set<object>();
export function retainNotification(n: { once(e: "click" | "close", cb: () => void): unknown }): void {
  retained.add(n);
  const release = () => retained.delete(n);
  n.once("click", release);
  n.once("close", release);
}
export function retainedNotificationCount(): number {
  return retained.size;
}
```

In `index.ts` `notification:show`: pass `pushActive` to `shouldShow`, and call `retainNotification(notification)` right before `notification.show()`.

- [ ] **Step 4: Bridge** `desktop-push-bridge.tsx`:

```tsx
import { useEffect } from "react";
import { api } from "@multica/core/api";

// The APNs token of this Mac while a user is logged in; read by beforeLogout.
let registeredToken: string | null = null;

export function unregisterPushOnLogout(): void {
  const token = registeredToken;
  registeredToken = null;
  window.desktopAPI.setPushActive?.(false);
  if (token) void api.unregisterPushDevice(token).catch(() => {});
}

// Mounted inside the logged-in shell. Registers this Mac for APNs and tells
// main to stop local banners so a notification never shows twice.
export function DesktopPushBridge({ appId }: { appId: string }) {
  useEffect(() => {
    if (!appId || !window.desktopAPI.registerPush) return;
    let cancelled = false;
    void (async () => {
      const result = await window.desktopAPI.registerPush();
      if (cancelled || !("token" in result)) return;
      try {
        await api.registerPushDevice({ platform: "macos", token: result.token, bundle_id: appId, environment: "production" });
        registeredToken = result.token;
        window.desktopAPI.setPushActive(true);
      } catch {
        // Local banners stay on; nothing else to do.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId]);
  return null;
}
```

Mount `<DesktopPushBridge appId={__CONTANGO_APP_ID__} />` next to `DesktopInboxBridge` in `desktop-layout.tsx` (declare the constant in `env.d.ts`). In `DesktopInboxBridge`'s effect also subscribe `window.desktopAPI.onRouteOpen((path) => pushRef.current(path))` and return both unsubscribers. In `App.tsx` pass `beforeLogout={unregisterPushOnLogout}` to `CoreProvider`.

- [ ] **Step 5: Run tests** — Step 2 + `pnpm --filter @multica/desktop typecheck && pnpm --filter @multica/desktop test`. Expected: PASS.
- [ ] **Step 6: Commit** — `feat(desktop): register for push after login, one banner per event, keep notifications clickable`.

---

### Task 7: Spike gate — push end to end on a real build (manual, owner + executor)

Needs Task 1 deployed on ops (ask the owner to run the admin-box deploy; give them the image digest and these env changes: add the desktop bundle id to `MULTICA_APNS_ALLOWED_BUNDLE_IDS`, comma-separated) and Tasks 2–6.

- [ ] Build: bump tag (`v0.7.0-contango.1` if unpublished, else next n), `contango:build`, install the DMG after the owner deletes `/Applications/Multica.app` (upstream).
- [ ] Log in. Check: `push_device` has a `macos` row for the owner (ask the admin box, or `GET`-free proof: the next step).
- [ ] Record each of these as PASS/FAIL in the PR description:

| # | Situation | Expected |
|---|---|---|
| a | App in background, someone comments on the owner's issue | One banner, "`<ID> · <who> commented`" / title / comment |
| b | Click (a) | Inbox opens on that issue |
| c | App quit, same trigger | Banner appears |
| d | Click (c) | App launches on that issue |
| e | Agent chat reply while app in background | Banner; click opens the chat |
| f | Log out, trigger again | No banner |
| g | App focused, push arrives | No banner duplicated compared with upstream behaviour (record what happens) |
| h | Fresh install, first registration | macOS asks for notification permission and banners show (no prompt or no authorization may mean silent banners; record) |

- [ ] Decision rules:
  - (c) fails → APNs isn't reaching a Developer ID app. Stop and report to the owner; options are dropping push (keep Tasks 4–6 behind the empty-`appId` switch) or a native module. Do not improvise.
  - (b) fails but (d) passes → Electron drops clicks for a running app. Implement: on `app.on("activate")` within 10 s of a `received-apns-notification`, call `openPushRoute(lastPushRoute)`; add a unit test for the 10 s window with fake timers; re-run (b).
  - (d) fails → `launchInfo` shape differs. Log `JSON.stringify(launchInfo)` to the dev log once, adjust the extraction in Task 5, re-run.

---

### Task 8: Open our server's web links in the app

**Files:**
- Create: `apps/desktop/src/main/web-link.ts`
- Modify: `apps/desktop/src/main/index.ts` (`open-url`, `second-instance`), `apps/desktop/scripts/contango-build.mjs` (protocols)
- Test: `apps/desktop/src/main/web-link.test.ts`

**Interfaces:**
- Produces: `appPathForWebUrl(url: string, appUrl: string): string | null` — the path+search+hash when `url`'s origin equals `appUrl`'s origin, else `null`.

- [ ] **Step 1: Failing tests:**

```ts
import { appPathForWebUrl } from "./web-link";
const APP = "https://srv.example.test";
it("maps our links to the in-app path", () => {
  expect(appPathForWebUrl("https://srv.example.test/acme/issues/abc?x=1#c", APP)).toBe("/acme/issues/abc?x=1#c");
});
it.each([
  "https://evil.example.test/acme/issues/abc",
  "http://srv.example.test/acme",        // different origin (scheme)
  "https://srv.example.test.evil.test/x",
  "not a url",
])("refuses %s", (u) => expect(appPathForWebUrl(u, APP)).toBeNull());
it("refuses the bare origin", () => expect(appPathForWebUrl("https://srv.example.test/", APP)).toBeNull());
```

- [ ] **Step 2: Run** — `pnpm vitest run src/main/web-link.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement:**

```ts
// Links a link router (e.g. Choosy) hands to the app. Only our own server's
// URLs open inside; everything else goes back to the default browser.
export function appPathForWebUrl(url: string, appUrl: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== new URL(appUrl).origin) return null;
    const path = `${u.pathname}${u.search}${u.hash}`;
    return path === "/" ? null : path;
  } catch {
    return null;
  }
}
```

In `index.ts` `open-url` handler (and the `second-instance` argv search): if the URL starts with `http:` or `https:`, compute `appPathForWebUrl(url, runtimeConfig.appUrl)`; when a path comes back, `dispatchToMainRenderer("route:open", path)` and focus the main window; otherwise `shell.openExternal(url)`. Keep `multica://` handling unchanged. If the runtime config is not loaded yet, queue the URL and process it after load (follow how `handleDeepLink` queues).

In `contango-build.mjs` add to the electron-builder args: `-c.protocols.0.name=Multica`, `-c.protocols.0.schemes.0=multica`, `-c.protocols.1.name=Web links`, `-c.protocols.1.schemes.0=https`, `-c.protocols.1.schemes.1=http`, `-c.protocols.1.role=Viewer`. Extend `contango-build.test.mjs` if you move these into `builderOverrides` (preferred: add `protocols` to the returned object and assert it).

- [ ] **Step 4: Run tests + typecheck.** Expected: PASS.
- [ ] **Step 5: Manual** — on the installed build: Choosy rule host → Multica; click an issue link in Slack → app opens on that issue; click a GitHub link with Choosy set to always-ask → Multica is listed, choosing it opens the browser instead.
- [ ] **Step 6: Commit** — `feat(desktop): open our server's web links in the app`.

---

### Task 9: Update feed on ops + release flow

**Files:**
- Create: `apps/desktop/scripts/contango-publish.sh` (fork repo)
- Ops changes go through the owner's admin-box agent (instruction text below).

**Interfaces:**
- Consumes: Task 3 artifacts in `apps/desktop/dist/`.
- Produces: `https://<server host>/desktop/{contango-mac.yml,*.zip,*.blockmap,*.dmg}`.

- [ ] **Step 1: Instruction for the admin-box agent** (give to the owner verbatim):

> On ops: create `/srv/multica-desktop` (owned by the deploy user, readable by Caddy; mount it read-only into the Caddy container if Caddy runs in one). In the ops Caddyfile, inside the `https://<server host>` site and before the final `handle`, add:
> ```
>     handle_path /desktop/* {
>         root * /srv/multica-desktop
>         file_server
>     }
> ```
> Reload Caddy. Add an admin-box script `publish-desktop <dir>` that rsyncs a directory from the admin box to ops `/srv/multica-desktop/`, uploading `contango-mac.yml` LAST so clients never see metadata before its ZIP. Commit both in the ops repo. Check: `curl -sI https://<server host>/desktop/` from the VPN returns 200 or 404 (not the web app's HTML).

- [ ] **Step 2: Publish script** `contango-publish.sh`:

```sh
#!/bin/sh
# Fork-only: copy a contango:build output to the admin box, which forwards it
# to ops (publish-desktop). Metadata goes last so updaters never see a
# version whose ZIP is missing.
set -eu
ADMIN="${CONTANGO_ADMIN_SSH:?set CONTANGO_ADMIN_SSH in .env.contango.local}"
DIST="$(cd "$(dirname "$0")/.." && pwd)/dist"
STAGE="desktop-release-$(date -u +%Y%m%dT%H%M%SZ)"
ssh "$ADMIN" "mkdir -p ~/$STAGE"
scp "$DIST"/*.dmg "$DIST"/*.zip "$DIST"/*.blockmap "$DIST"/contango-mac.yml "$ADMIN:~/$STAGE/"
ssh "$ADMIN" "publish-desktop ~/$STAGE"
```

Add `CONTANGO_ADMIN_SSH=ubuntu@<admin host>` to the env file template in Task 2. Run it in the foreground (SSH keys are touch-confirmed).

- [ ] **Step 3: First publish** — publish the build from Task 7, then `curl -s https://<server host>/desktop/contango-mac.yml` shows `0.7.0-contango.1`.
- [ ] **Step 4: Update E2E** — tag `v0.7.0-contango.2`, build, publish. On the Mac running `.1`: wait up to 1 h or use Settings → Updates → check; quit → reopen → About shows `0.7.0-contango.2`.
- [ ] **Step 5: Push tags + branch** — `git push contango contango/desktop-build v0.7.0-contango.1 v0.7.0-contango.2`. (Tags contain no secrets.)
- [ ] **Step 6: Commit** — `chore(desktop): fork release publish script`.

---

### Task 10: Docs for the owner

**Files:**
- Create: `docs/contango/desktop-release.md`

- [ ] Write a one-screen page: prerequisites (Task 2 list), release = tag → `contango:build` → `contango-publish.sh`, first install for a new person (VPN on, download `https://<server host>/desktop/<dmg>`, delete upstream app first), rebase on a new upstream (reset to `v<new>-contango.1`), rollback (re-publish the previous version's files; set `allowDowngrade` is NOT on, so a bad build is fixed forward with `n+1`).
- [ ] Commit — `docs: fork desktop release runbook`.
