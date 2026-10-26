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
> (`multica.ai`). Without our values in the EAS `production` environment, a
> build would fall back to those upstream URLs and the upstream bundle id, and
> an OTA update (which reads ONLY the EAS environment, never
> `.env.production.local`) would crash at launch and roll back.
> `app.config.ts` refuses both once `EAS_PROJECT_ID_PROD` is set: a production
> config with missing values, or URLs pointing at `multica.ai`, fails with an
> error naming the variable. After the first build and first update, run the
> verification in section 4 anyway.

**Every `eas` command after `eas init` (checklist step 3) runs from
`apps/mobile` with `APP_ENV=production` in front.** It selects the production config, which holds the committed
project id; without it the CLI sees the development variant, finds no project
and offers to create one. Answer no if that ever happens.

## 1. Owner checklist

Secret-store writes (`eas env:*`) are done by the owner; agents cannot.

1. **EAS CLI.** Install eas-cli 21.1.0 or newer globally
   (`npm install -g eas-cli`); it is not a repo dependency. Get access to the
   Contango Expo org, then `eas login`.
2. **App Store Connect**
   - Confirm the app record for `<BUNDLE_ID>` exists (version 0.1.0 builds 1–3
     were uploaded from Xcode).
   - Users and Access, Integrations, App Store Connect API: create a key with
     Admin (or use the Account Holder). EAS Submit uses it (step 8).
   - Apple Developer, Identifiers, `<BUNDLE_ID>`: enable **Associated Domains**.
     (Push Notifications is enabled already for the push rollout.)
   - Copy the numeric app id: App Store Connect, the app, App Information,
     **Apple ID**.
3. **Project id.** From `apps/mobile`: `eas init` and pick the Contango org.
   `app.config.ts` is dynamic, so `eas init` cannot edit it and prints the id
   instead. Set `EAS_PROJECT_ID_PROD` in `apps/mobile/app.config.ts` to that
   id and commit it (not secret). The production variant uses it from then on;
   no `EAS_PROJECT_ID` variable is needed anywhere.
4. **EAS `production` environment variables.** Every variable `app.config.ts`
   reads in production, plus `APP_ENV`; values from `.env.production.local`:

   ```bash
   cd apps/mobile
   for kv in \
     APP_ENV=production \
     EXPO_PUBLIC_API_URL=<API_URL> \
     EXPO_PUBLIC_WEB_URL=<WEB_URL> \
     EXPO_BUNDLE_IDENTIFIER_PROD=<BUNDLE_ID> \
     EXPO_APPLE_TEAM_ID=<TEAM_ID> \
     EXPO_ASSOCIATED_DOMAIN=<SERVER_HOST>; do
     APP_ENV=production eas env:set --environment production \
       --name "${kv%%=*}" --value "${kv#*=}" \
       --visibility plaintext --non-interactive
   done
   APP_ENV=production eas env:list --environment production
   ```

   `APP_ENV` must be in the EAS environment: `eas update --environment
   production` evaluates the config with that environment (dotenv files off),
   and without `APP_ENV=production` the update would get a development
   fingerprint and never reach the build. `eas env:set` also changes an
   existing value later.
5. **ascAppId.** EAS Submit cannot read the app id from an environment
   variable. Edit `apps/mobile/eas.json`:
   `"submit": { "production": { "ios": { "ascAppId": "<ASC_APP_ID>" } } }`,
   and commit it (a numeric id, not secret).
6. **Check the config.** `APP_ENV=production eas config --platform ios
   --profile production` (it loads the profile's EAS environment) and confirm
   the bundle id, associated domain and updates URL.
7. **Build number.** Builds 1–3 of 0.1.0 came from Xcode, so EAS's remote
   build number must start above them:
   `APP_ENV=production eas build:version:set -p ios` (production profile) and
   enter `3` or higher. `autoIncrement` adds one before each build, so the
   first EAS build gets the next free number.
8. **Credentials.** `eas credentials` evaluates the config without the EAS
   environment, so load our values from the local file:
   `APP_ENV=production pnpm exec dotenv -e .env.production.local -- eas credentials -p ios`,
   pick the `production` profile and check the bundle id is `<BUNDLE_ID>`.
   Let EAS create the distribution certificate and provisioning profile, then
   under **App Store Connect: Manage your API Key** choose **Set up your
   project to use an API Key for EAS Submit** and give it the key from step 2.
   (Alternatively, the first `--auto-submit` prompts for the key.)
9. **Association file.** Generate it on this Mac (needs this pnpm checkout and
   Node 22.18 or newer):
   `pnpm exec dotenv -e .env.production.local -- node scripts/print-aasa.mjs > /tmp/aasa.json`.
   Paste its contents into section 2 where marked and hand the prompt to the
   admin-box agent.
10. **Testers.** App Store Connect, Users and Access: add each tester, give
    app access, create a TestFlight **internal** group and add them. Testers
    need the company VPN on to reach the server.

## 2. Ops prompt for the admin-box agent (ready to paste)

```text
Task: serve the iOS universal-link association file for <SERVER_HOST>.

Context: the Multica server <SERVER_HOST> is reachable publicly only through
the existing Cloudflare tunnel; the app is reached on the company VPN via
internal DNS. iOS verifies universal links by fetching the association file
over public HTTPS (through Apple's CDN), so exactly one path must be public.

The file (generated by the owner; do not commit it anywhere), saved as
/tmp/aasa.json:
<PASTE THE CONTENTS OF /tmp/aasa.json HERE>
Validate it is JSON with `applinks.details[0].appIDs` = ["<TEAM_ID>.<BUNDLE_ID>"].

Do:
1. Make sure <SERVER_HOST> has a PUBLIC DNS record in Cloudflare pointing at
   the existing tunnel (proxied CNAME to <tunnel-id>.cfargotunnel.com); the
   internal DNS record stays as it is.
2. On the existing Cloudflare tunnel, add a PUBLIC route for <SERVER_HOST> that
   serves ONLY GET /.well-known/apple-app-site-association with the file as
   the body, `Content-Type: application/json`, HTTP 200, no redirects (no
   http->https hop that changes the host, no trailing-slash redirect).
3. No challenge on that path: no Cloudflare Access policy, WAF/managed
   challenge, Bot Fight Mode or "Under Attack" mode may apply to it. Apple's
   CDN fetcher cannot solve challenges and the links silently stop working.
4. Every other path on that public route returns 404. Do not proxy to the
   Multica backend from the public route.
5. Leave VPN/internal DNS and the existing internal route unchanged.

Verify and report:
- curl -sSI https://<SERVER_HOST>/.well-known/apple-app-site-association
  -> 200, content-type application/json, no Location header.
- curl -sS -o /dev/null -w '%{http_code}\n' https://<SERVER_HOST>/ and
  /api/me from OUTSIDE the VPN -> 404.
- curl -sS https://<SERVER_HOST>/.well-known/apple-app-site-association | diff - /tmp/aasa.json
- curl -sS https://app-site-association.cdn-apple.com/a/v1/<SERVER_HOST>
  -> the same JSON. Apple's CDN caches, so a 404 or stale body can last a
  while (up to about a day); retry later before changing anything.
Report the outputs, the DNS and tunnel config diff, and how to roll them back.
```

## 3. Release, OTA, rollback

All from `apps/mobile`, logged in. The build is iOS only, store distribution,
remote app versioning with auto-increment, on the image pinned in `eas.json`
(Xcode 27.0), with the Node and pnpm versions pinned there.

```bash
# New native build, uploaded to TestFlight
APP_ENV=production eas build -p ios --profile production --auto-submit

# Before the FIRST update to a build: its fingerprint must match the local one
APP_ENV=production eas fingerprint:compare --build-id <BUILD_ID> --environment production

# JS-only change over the air (reaches builds with the same fingerprint)
APP_ENV=production eas update --channel production --environment production \
  -p ios --message "<what changed>"

# Native change (dependency, config, plugin): OTA will not reach old builds; build again.

# Rollback: list, then republish a previous update or go back to the embedded one
APP_ENV=production eas update:list --branch production -p ios
APP_ENV=production eas update:republish --group <UPDATE_GROUP_ID> \
  --destination-channel production -p ios
APP_ENV=production eas update:rollback -p ios
```

OTA behaviour in the app: a downloaded update prompts to restart; "Later"
keeps the user in place and the update applies on the next normal launch.
The profile's `"environment": "production"` applies to builds only; updates
need `--environment production` as above.

## 4. Verify the app targets our server

After the first build and after each update that touches env vars:

1. EAS dashboard, the build/update: the environment is `production`, and
   `APP_ENV=production eas env:list --environment production` shows all six
   variables.
2. `APP_ENV=production eas config --platform ios --profile production` shows
   `<BUNDLE_ID>`.
3. For an update, export the bundle with only the EAS environment and search
   it for the upstream host:
   `APP_ENV=production eas env:exec production "EXPO_NO_DOTENV=1 pnpm exec expo export -p ios --output-dir /tmp/mobile-export"`
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
  Associated Domains capability must be on the app id). Check that no
  Cloudflare challenge applies to the path. iOS caches the file at install:
  delete and reinstall the app after fixing the file. Long-pressing a link in
  Notes or Messages is the quickest test.
- **Config error naming `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_WEB_URL` or
  `EXPO_BUNDLE_IDENTIFIER_PROD`.** The EAS `production` environment is missing
  that value or points at `multica.ai`: `APP_ENV=production eas env:list
  --environment production`, fix with `APP_ENV=production eas env:set`, then
  rerun the command. Run section 4.
- **The CLI offers to create a project.** `APP_ENV=production` is missing in
  front of the command, or `EAS_PROJECT_ID_PROD` is unset (step 3). Answer no.
- **`eas submit` asks for an Apple sign-in.** `ascAppId` is missing from
  `eas.json` (checklist step 5) or the App Store Connect API key is not set up
  (step 8).
- **Update does not appear.** The fingerprint differs: run the
  `fingerprint:compare` command from section 3. If `APP_ENV` is missing from
  the EAS environment (step 4) the update has a development fingerprint; add
  it and publish again. If the native layer changed, ship a new build instead.
