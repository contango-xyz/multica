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

One-time ops setup (feed directory, Caddy `/desktop/*` route, APNs allowed bundle id, push-device
migration deploy) is done by the admin-box agent, not by this runbook.

## Release

1. Tag the commit: `git tag v<upstream>-contango.<n>` (for example `v0.7.0-contango.2`). The build
   refuses to run unless HEAD has exactly such a tag.
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

VPN on, download `https://<server host>/desktop/<dmg>`, delete the upstream Multica app first
(different app id, both would register as the same URL handler), open the DMG, drag to Applications.

## Rebase on a new upstream

Follow the checklist in `PATCHES.md`, then start a fresh series at `v<new>-contango.1`.

## Rollback

Re-publish the previous version's files (all of them, metadata last). Downgrade is NOT enabled in the
updater (`allowDowngrade` off), so clients on the bad build will not move back: fix forward with
`n+1`.
