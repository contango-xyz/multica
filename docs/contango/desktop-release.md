# Desktop release runbook (fork)

The fork ships a signed, notarized macOS (arm64) build of the Electron app, updated from our own feed
at `https://<server host>/desktop/`. Upstream's packaging is untouched; the fork build is
`apps/desktop/scripts/contango-build.mjs`.

## Prerequisites (on the build Mac)

- Developer ID Application certificate and its private key in the login keychain.
  **The certificate expires 2027-11-25.** Renewal: the Account Holder issues a new certificate from a
  CSR. The private key is backed up in the owner's password manager; restore it before building on a
  new Mac.
- Provisioning profile for `<bundle id>` (push entitlement), team `<team id>`.
- A `notarytool` keychain profile (`xcrun notarytool store-credentials`).
- `apps/desktop/.env.contango.local` (git-ignored, never committed): `CONTANGO_APP_ID`,
  `CONTANGO_TEAM_ID`, `CONTANGO_PROVISIONING_PROFILE`, `CONTANGO_API_URL`, `CONTANGO_UPDATE_URL`,
  `APPLE_KEYCHAIN_PROFILE`, `CONTANGO_ADMIN_SSH` (`ubuntu@<admin host>`).
- The company VPN on, and the SSH key for `<admin host>` (touch-confirmed).
- Xcode command line tools (`xcode-select --install`): the build compiles the push-click addon with
  `node-gyp` against the Electron headers before packaging.

One-time ops setup (feed directory, Caddy `/desktop/*` route, APNs allowed bundle id, push-device
migration deploy) is done by the admin-box agent, not by this runbook.

## Release

1. Tag the commit: `git tag v<upstream>-contango.<n>` (for example `v0.7.0-contango.2`). The build
   refuses to run unless HEAD has exactly such a tag and tracked files have no uncommitted changes.
2. `unset CDPATH; pnpm --filter @multica/desktop contango:build`. Takes more than 10 minutes
   (notarization). A final gate runs `codesign --verify` and `stapler validate`; if it fails, do not
   publish.
3. `apps/desktop/scripts/contango-publish.sh`. Run it in the foreground (SSH touch prompts). It sends
   the DMG, ZIP and blockmaps first and `contango-mac.yml` last, then runs `publish-desktop` on the
   admin box.
4. Check: `curl -s https://<server host>/desktop/contango-mac.yml` shows the new version. Installed
   apps pick it up within an hour, or via Settings, Updates.
5. Push the tag and branch to the fork remote.

## First install for a new person

VPN on, open the web app's download page (`https://<server host>/download`, also the Help menu's
"Desktop app" entry) and take the macOS button, or download `https://<server host>/desktop/<dmg>`, delete the upstream Multica app first
(different app id, both would register as the same URL handler), open the DMG, drag to Applications.

The page offers our DMG only when ops set `MULTICA_DESKTOP_FEED_URL` on the web container (runtime
env, not a build arg): the absolute feed base, `https://<server host>/desktop/`. Unset, or when the
feed cannot be read, the page shows upstream's releases. In this mode the page shows only our macOS (Apple Silicon) download and its version: no
Windows/Linux/Intel buttons, CLI or cloud sections, and no upstream release links.

## Opening links in the app

Links to our server (GitHub PR bodies, web Slack, email, bookmarks) stay `https://`. In each browser,
open Settings → This device → Desktop app, and turn on "Open links in the desktop app" (per browser, off by
default). A workspace link opened as a fresh page load then hands off to the app via
`multica://open?path=...` and shows a panel with "Continue in browser" and "Stop opening links in the
app". Reloads, in-app navigation and returns from other sites (such as a checkout) stay in the
browser. Turn it on only in desktop browsers, not on a phone (the mobile app registers `multica://`
but has no open route). An upstream desktop app, or no app, just
comes forward or does nothing, so "Continue in browser" covers it.

The Choosy (or similar) browser-picker rule is optional: it is still useful for links from native
apps such as Slack desktop or Mail, which never reach the web setting.

## How the fork build differs at runtime

- **Push clicks:** Electron drops clicks on APNs notifications while the app runs. The fork ships a
  small native addon (`apps/desktop/native/push-click`, loaded from `Contents/Resources/push-click.node`)
  that reports each click (default action only, not a dismiss) with its payload, so the app opens
  exactly the clicked item, foreground or from Notification Centre. If the addon fails to load or
  start, the app falls back to the old rule: an activation within 10 s of a background push opens
  that push. Upstream and dev builds never have the addon.
- **Foreground banners:** to install the hook, the app sets up macOS notifications at launch, so pushes
  now also show a banner while the app is in front (and the notification permission prompt appears
  at first launch).
- **Fuses:** fork builds disable the Electron fuses for running as Node, `NODE_OPTIONS` and
  `--inspect`.

## Rebase on a new upstream

Follow the checklist in `PATCHES.md`, then start a fresh series at `v<new>-contango.1`.

## Rollback

Installed clients never downgrade (`allowDowngrade` is off), so re-publishing the previous version's
files only changes what new installs download. Fix a bad build forward: commit the fix, or `git
revert` the bad commits back to the last good tag's code, tag the result `n+1`, build and publish
it. Don't put `n+1` on the old tagged commit itself: the build reads the version from the one tag on
HEAD.
