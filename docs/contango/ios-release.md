# iOS release runbook (TestFlight, OTA, rollback)

Ships the mobile app (`apps/mobile`) to the team through TestFlight, with push
and universal links to our self-hosted server. Push server setup:
`docs/contango/push-rollout.md`.

Placeholders: `<SERVER_HOST>` (server host, no scheme), `<API_URL>` /
`<WEB_URL>` (full public URLs), `<TEAM_ID>` (Apple team id), `<BUNDLE_ID>`
(production bundle id), `<EAS_PROJECT_ID>`, `<ASC_APP_ID>` (numeric App Store
Connect app id). Real values live in the git-ignored
`apps/mobile/.env.production.local` and in the EAS `production` environment.

> **WARNING: define our own values in the EAS `production` environment.**
> The committed `apps/mobile/.env.production` holds the UPSTREAM public URLs
> (`multica.ai`). If the EAS `production` environment lacks our
> `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_WEB_URL`, builds and OTA updates
> silently target upstream, and `EXPO_BUNDLE_IDENTIFIER_PROD` falls back to
> the upstream bundle id. OTA updates read ONLY the EAS environment, never
> `.env.production.local`. After the first build and first update, run the
> verification in section 4.

## 1. Owner checklist

Secret-store writes (`eas env:*`) are done by the owner; agents cannot.

1. **App Store Connect**
   - Create the app record for `<BUNDLE_ID>`.
   - Users and Access, Integrations, App Store Connect API: create a key with
     Admin (or use the Account Holder). EAS Submit uses it.
   - Apple Developer, Identifiers, `<BUNDLE_ID>`: enable **Associated Domains**.
     (Push Notifications is enabled already for the push rollout.)
   - Copy the numeric app id: App Store Connect, the app, App Information,
     **Apple ID**.
2. **Expo org.** Get access to the Contango Expo org, then `pnpm exec eas login`.
3. **Project id.** From `apps/mobile`: `pnpm exec eas init` and pick the
   Contango org. `app.config.ts` is dynamic, so `eas init` cannot edit it and
   will print the id instead. The config reads the id from `EAS_PROJECT_ID`
   (it also honours `extra.eas.projectId`, which `eas init` cannot write here).
   Use `EAS_PROJECT_ID`:
   - add `EAS_PROJECT_ID=<EAS_PROJECT_ID>` to `.env.production.local`;
   - add it to the EAS `production` environment (step 4);
   - when running `eas` commands from your shell, prefix them with
     `EAS_PROJECT_ID=<EAS_PROJECT_ID>` (the CLI evaluates `app.config.ts` with
     your shell environment). The id is not secret.
4. **EAS `production` environment variables.** Every variable `app.config.ts`
   reads in production; values from `.env.production.local`:

   ```bash
   cd apps/mobile
   for kv in \
     EXPO_PUBLIC_API_URL=<API_URL> \
     EXPO_PUBLIC_WEB_URL=<WEB_URL> \
     EXPO_BUNDLE_IDENTIFIER_PROD=<BUNDLE_ID> \
     EXPO_APPLE_TEAM_ID=<TEAM_ID> \
     EXPO_ASSOCIATED_DOMAIN=<SERVER_HOST> \
     EAS_PROJECT_ID=<EAS_PROJECT_ID>; do
     pnpm exec eas env:create --environment production \
       --name "${kv%%=*}" --value "${kv#*=}" \
       --visibility plaintext --non-interactive
   done
   pnpm exec eas env:list --environment production
   ```

   `APP_ENV=production` already comes from the `build.production.env` block in
   `eas.json`; for OTA updates `app.config.ts` also needs it, see the update
   command in section 3 (`APP_ENV=production` is set there). To change a value
   later, use `eas env:update` (or delete and create again).
5. **Credentials.** `pnpm exec eas credentials -p ios` (production profile):
   let EAS create the distribution certificate and provisioning profile.
6. **ascAppId.** EAS Submit cannot read the app id from an environment
   variable. Edit `apps/mobile/eas.json`:
   `"submit": { "production": { "ios": { "ascAppId": "<ASC_APP_ID>" } } }`,
   and commit it (a numeric id, not secret).
7. **Check the config.** `EAS_PROJECT_ID=<EAS_PROJECT_ID> pnpm exec eas config
   --platform ios --profile production --environment production` and confirm
   the bundle id, associated domain and updates URL.
8. **Association file.** Hand section 2 to the admin-box agent.
9. **Testers.** App Store Connect, Users and Access: add each tester, give
   app access, create a TestFlight **internal** group and add them. Testers
   need the company VPN on to reach the server.

## 2. Ops prompt for the admin-box agent (ready to paste)

```text
Task: serve the iOS universal-link association file for <SERVER_HOST>.

Context: the Multica server <SERVER_HOST> is reachable publicly only through
the existing Cloudflare tunnel; the app is reached on the company VPN via
internal DNS. iOS verifies universal links by fetching the association file
over public HTTPS, so exactly one path must be public.

Do:
1. Generate the file (values from the owner; do not commit them):
   cd apps/mobile && EXPO_APPLE_TEAM_ID=<TEAM_ID> \
     EXPO_BUNDLE_IDENTIFIER_PROD=<BUNDLE_ID> \
     node scripts/print-aasa.mjs > /tmp/aasa.json
   Validate it is JSON with `applinks.details[0].appIDs` = ["<TEAM_ID>.<BUNDLE_ID>"].
2. On the existing Cloudflare tunnel, add a PUBLIC route for <SERVER_HOST> that
   serves ONLY GET /.well-known/apple-app-site-association with the file as
   the body, `Content-Type: application/json`, HTTP 200, no redirects (no
   http->https hop that changes the host, no trailing-slash redirect).
3. Every other path on that public route returns 404. Do not proxy to the
   Multica backend from the public route.
4. Leave VPN/internal DNS and the existing internal route unchanged.

Verify and report:
- curl -sSI https://<SERVER_HOST>/.well-known/apple-app-site-association
  -> 200, content-type application/json, no Location header.
- curl -sS -o /dev/null -w '%{http_code}\n' https://<SERVER_HOST>/ and
  /api/me from OUTSIDE the VPN -> 404.
- curl -sS https://<SERVER_HOST>/.well-known/apple-app-site-association | diff - /tmp/aasa.json
- curl -sS https://app-site-association.cdn-apple.com/a/v1/<SERVER_HOST>
  -> the same JSON. Apple's CDN caches, so a 404 or stale body can last a
  while (up to about a day); retry later before changing anything.
Report the outputs, the tunnel config diff, and how to roll the route back.
```

## 3. Release, OTA, rollback

All from `apps/mobile`, logged in, with `EAS_PROJECT_ID=<EAS_PROJECT_ID>` in
the shell. The build is iOS only, store distribution, remote app versioning
with auto-increment, on the image pinned in `eas.json` (Xcode 27.0).

```bash
# New native build, uploaded to TestFlight
pnpm exec eas build -p ios --profile production --auto-submit

# JS-only change over the air (reaches builds with the same fingerprint)
APP_ENV=production pnpm exec eas update --channel production \
  --environment production --message "<what changed>"

# Native change (dependency, config, plugin): OTA will not reach old builds; build again.

# Rollback: list, then republish a previous update or go back to the embedded one
pnpm exec eas update:list --branch production
pnpm exec eas update:republish --group <UPDATE_GROUP_ID> --destination-channel production
pnpm exec eas update:rollback
```

OTA behaviour in the app: a downloaded update prompts to restart; "Later"
keeps the user in place and the update applies on the next normal launch.
The profile's `"environment": "production"` applies to builds only; updates
need `--environment production` as above.

## 4. Verify the app targets our server

After the first build and after each update that touches env vars:

1. EAS dashboard, the build/update: the environment is `production`, and
   `eas env:list --environment production` shows all six variables.
2. `EAS_PROJECT_ID=<EAS_PROJECT_ID> pnpm exec eas config --platform ios
   --profile production --environment production` shows `<BUNDLE_ID>`.
3. For an update, export the bundle and search it for the upstream host:
   `APP_ENV=production pnpm exec eas env:exec production "pnpm exec expo export -p ios --output-dir /tmp/mobile-export"`
   then `grep -c 'api.multica.ai' /tmp/mobile-export/_expo/static/js/ios/*.hbc`
   must print 0 and `grep -c '<SERVER_HOST>' ...` must be greater than 0.
4. On a TestFlight install (VPN on): sign in. If sign-in reaches the server,
   the app points at us; it never would against upstream.

## 5. Troubleshooting

- **Push not arriving.** Check the device row on the server: `push_device`
  for that user must have `environment = 'production'` (TestFlight and App
  Store builds register as production). A `sandbox` row means a dev build.
  Then check notification permission in iOS Settings; re-enabling registers on
  the next foreground. Server side: `docs/contango/push-rollout.md`.
- **Links open Safari, not the app.** The association file is not verified:
  repeat the CDN check from section 2 and confirm the appID matches
  `<TEAM_ID>.<BUNDLE_ID>` and the build has `applinks:<SERVER_HOST>`
  (`EXPO_ASSOCIATED_DOMAIN` set in the EAS environment at build time; the
  Associated Domains capability must be on the app id). iOS caches the file at
  install: delete and reinstall the app after fixing the file. Long-pressing
  a link in Notes or Messages is the quickest test.
- **App points at upstream (`multica.ai`) or sign-in fails.** The EAS
  `production` environment is missing or has wrong values: `eas env:list
  --environment production`, fix with `eas env:update`, then rebuild (builds)
  or republish (OTA). Run section 4.
- **`eas submit` asks for an Apple sign-in.** `ascAppId` is missing from
  `eas.json` (checklist step 6) or the App Store Connect API key is not set up.
- **Update does not appear.** Native layer changed (fingerprint differs): ship
  a new build instead.
