import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * Dynamic Expo config — replaces app.json so we can read APP_ENV at runtime
 * and switch bundleIdentifier / display name for dev / staging / production.
 *
 * APP_ENV is set by package.json scripts:
 *   - dev          → APP_ENV unset (treated as "development")
 *   - dev:staging  → APP_ENV=staging
 *   - dev:prod     → APP_ENV=production (rare; usually only for EAS build)
 */
/**
 * Our EAS project id, committed so production `eas` commands need no
 * EAS_PROJECT_ID in the shell: the CLI resolves the project before it loads
 * the EAS environment. Set to the UUID printed by `eas init`
 * (docs/contango/ios-release.md, owner checklist step 3). Not secret.
 */
export const EAS_PROJECT_ID_PROD: string | undefined = "9aef661a-96e2-4d62-9134-fe0263a4578b";

const UPSTREAM_HOST = "multica.ai";

function isUpstreamOrInvalid(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const host = new URL(url).hostname;
    return host === UPSTREAM_HOST || host.endsWith(`.${UPSTREAM_HOST}`);
  } catch {
    return true;
  }
}

/**
 * Production with an EAS project is our TestFlight build. Without our values
 * it would fall back to the committed upstream `.env.production` and bundle
 * id (builds) or crash at launch and roll back (OTA updates), so refuse.
 * Upstream production builds have no project id and are not checked.
 *
 * eas-cli evaluates this file once without the EAS environment (with dotenv
 * off) just to read the project id, so an evaluation where none of these
 * variables is set is only checked on the EAS builder itself.
 */
const PRODUCTION_VARS = [
  "EXPO_PUBLIC_API_URL",
  "EXPO_PUBLIC_WEB_URL",
  "EXPO_BUNDLE_IDENTIFIER_PROD",
] as const;

function assertOurProduction(): void {
  if (!process.env.EAS_BUILD && PRODUCTION_VARS.every((name) => !process.env[name])) return;
  const problems = [
    isUpstreamOrInvalid(process.env.EXPO_PUBLIC_API_URL) && "EXPO_PUBLIC_API_URL",
    isUpstreamOrInvalid(process.env.EXPO_PUBLIC_WEB_URL) && "EXPO_PUBLIC_WEB_URL",
    !process.env.EXPO_BUNDLE_IDENTIFIER_PROD && "EXPO_BUNDLE_IDENTIFIER_PROD",
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(
      `Production config with an EAS project needs our own ${problems.join(", ")} ` +
        "(missing, invalid or pointing at multica.ai). Set them in the EAS " +
        "production environment or .env.production.local; see docs/contango/ios-release.md.",
    );
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const env = process.env.APP_ENV ?? "development";
  const isProd = env === "production";
  const isStaging = env === "staging";
  // EAS Update is enabled only once the project exists (`eas init`), so local
  // dev / prebuild keep working without it. The id is not secret.
  const easProjectId =
    (config.extra?.eas as { projectId?: string } | undefined)?.projectId ??
    process.env.EAS_PROJECT_ID ??
    (isProd ? EAS_PROJECT_ID_PROD : undefined);
  if (process.env.EAS_BUILD && !easProjectId) {
    throw new Error(
      "EAS build without an EAS project id: set EAS_PROJECT_ID_PROD in app.config.ts.",
    );
  }
  if (isProd && easProjectId) assertOurProduction();

  return {
    ...config,
    name: isProd
      ? "Multica"
      : isStaging
        ? "Multica (Staging)"
        : "Multica (Dev)",
    slug: "multica-mobile",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    scheme: "multica",
    // 1024x1024 full-bleed, no-alpha source that belongs to mobile alone. Do
    // not point this back at the desktop icon (apps/desktop/build/icon.png):
    // that one is padded for macOS, and iOS would mask it a second time, which
    // is the white ring from #6995. Expo prebuild generates every required iOS
    // icon size from this single PNG.
    icon: "./assets/icon.png",
    ios: {
      // Expo keeps the top-level portrait policy for iPhone while adding all
      // iPad orientations required for multitasking when tablet support is on.
      supportsTablet: true,
      // Only OS-provided HTTPS (exempt encryption): sets ITSAppUsesNonExemptEncryption=false
      // so App Store Connect stops asking the export-compliance question per build.
      config: { usesNonExemptEncryption: false },
      // Pins DEVELOPMENT_TEAM on every prebuild. Leaving it unset is the normal
      // path — `expo run:ios` then resolves a signing identity from the Keychain
      // itself, which is right when the Apple ID owns exactly one team. With
      // several (a personal team plus an employer's) it takes the *first*
      // identity found whenever the terminal is non-interactive, writes that
      // choice into the generated ios/, and never clears it again: prebuild only
      // writes DEVELOPMENT_TEAM when a value is present, so a project pinned to
      // the wrong team stays wrong until ios/ is deleted. Setting this re-applies
      // the intended team on every `scripts/ios-run.sh` run, which also repairs
      // an already-mispinned checkout.
      appleTeamId: process.env.EXPO_APPLE_TEAM_ID,
      // Per-variant bundle id overrides exist for one reason: an Apple ID
      // can only sign bundle prefixes it owns, so contributors not on the
      // Multica Apple Developer team (and external users self-building a
      // personal copy against production) need to swap to a reverse-domain
      // they control. Each variant has its own `_<VARIANT>` suffix and is
      // only read inside that variant's branch — a generic
      // `EXPO_BUNDLE_IDENTIFIER` would leak across variants (Expo CLI
      // auto-loads `.env.<mode>.local` regardless of APP_ENV) and collapse
      // dev / staging / prod onto a single id.
      bundleIdentifier: isProd
        ? (process.env.EXPO_BUNDLE_IDENTIFIER_PROD ?? "ai.multica.mobile")
        : isStaging
          ? (process.env.EXPO_BUNDLE_IDENTIFIER_STAGING ?? "ai.multica.mobile.staging")
          : (process.env.EXPO_BUNDLE_IDENTIFIER_DEV ?? "ai.multica.mobile.dev"),
      // Universal links (lib/universal-links.ts). Host only, from env so the
      // server hostname stays out of the repo; production variant only, since
      // the server's association file names the production app id.
      associatedDomains:
        isProd && process.env.EXPO_ASSOCIATED_DOMAIN
          ? [`applinks:${process.env.EXPO_ASSOCIATED_DOMAIN}`]
          : [],
    },
    plugins: [
      "expo-router",
      "expo-image",
      "expo-localization",
      "expo-secure-store",
      "expo-notifications",
      "@react-native-community/datetimepicker",
      "react-native-enriched-markdown",
      [
        "expo-image-picker",
        {
          // iOS NSPhotoLibraryUsageDescription. Without this string in
          // Info.plist, calling launchImageLibraryAsync hard-crashes on
          // iOS 14+. Camera + microphone are disabled — we only ever read
          // from the existing photo library.
          photosPermission:
            "Allow Multica to access your photos to attach images to issues and comments.",
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
      [
        "expo-build-properties",
        {
          ios: {
            buildReactNativeFromSource: true,
            // SDK 57's supported scene runtime is required for Xcode 27 builds.
            // Keep this in prebuild config so clean native generations retain it.
            enableSceneSupport: true,
          },
        },
      ],
    ],
    // Fingerprint policy: an OTA update only reaches builds whose native layer
    // matches, so JS-only changes ship over the air and native ones need a build.
    runtimeVersion: { policy: "fingerprint" },
    ...(easProjectId
      ? {
          updates: {
            url: `https://u.expo.dev/${easProjectId}`,
            checkAutomatically: "ON_LOAD" as const,
          },
        }
      : {}),
    extra: {
      ...config.extra,
      APP_ENV: env,
      ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
    },
  };
};
