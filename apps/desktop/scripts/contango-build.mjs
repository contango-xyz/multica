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
// electron-builder picks the APPLE_* ones over APPLE_KEYCHAIN_PROFILE when
// present; CSC_IDENTITY_AUTO_DISCOVERY=false would skip signing entirely.
// native/push-click: reports clicks on APNs notifications (src/main/push-click.ts).
// Platform extraResources add to upstream's list instead of replacing it; the
// file lands in Contents/Resources, outside the asar, and is signed with the app.
export const PUSH_CLICK_ADDON = { from: "native/push-click/build/Release/push_click.node", to: "push-click.node" };
const STRIPPED_ENV = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "CSC_IDENTITY_AUTO_DISCOVERY"];

export function renderEntitlements(template, env) {
  return template
    .replaceAll("{{APP_IDENTIFIER}}", `${env.CONTANGO_TEAM_ID}.${env.CONTANGO_APP_ID}`)
    .replaceAll("{{TEAM_ID}}", env.CONTANGO_TEAM_ID);
}

export function builderOverrides(env, entitlementsPath) {
  for (const k of REQUIRED) if (!env[k]) throw new Error(`${k} missing from .env.contango.local`);
  for (const k of ["CONTANGO_API_URL", "CONTANGO_UPDATE_URL"]) {
    let url;
    try {
      url = new URL(env[k]);
    } catch {
      throw new Error(`${k} must be an http(s) URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${k} must be an http(s) URL`);
  }
  return {
    appId: env.CONTANGO_APP_ID,
    mac: {
      entitlements: entitlementsPath,
      provisioningProfile: env.CONTANGO_PROVISIONING_PROFILE,
      notarize: true,
      extraResources: [PUSH_CLICK_ADDON],
    },
    publish: { provider: "generic", url: env.CONTANGO_UPDATE_URL, channel: "contango" },
    // Arrays replace upstream's list, so multica:// is restated.
    protocols: [
      { name: "Multica", schemes: ["multica"] },
      { name: "Web links", schemes: ["https", "http"], role: "Viewer" },
    ],
    // The app holds the user's session and push token; without these anything
    // running as the user could start it as plain Node or attach a debugger.
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
    },
  };
}

// A config file extending upstream's electron-builder.yml. `publish` is an
// array because electron-builder deep-merges an object into upstream's github
// publish (keeping owner/repo/releaseType); an array replaces it.
export function builderConfig(overrides, baseConfigPath, version) {
  return {
    extends: baseConfigPath,
    appId: overrides.appId,
    extraMetadata: { version },
    mac: overrides.mac,
    publish: [overrides.publish],
    protocols: overrides.protocols,
    electronFuses: overrides.electronFuses,
  };
}

// Compiles the addon against the installed Electron's headers (N-API, arm64).
export function addonBuildArgs(electronVersion) {
  return ["exec", "node-gyp", "rebuild", "--directory", "native/push-click", `--target=${electronVersion}`,
    "--arch=arm64", "--dist-url=https://electronjs.org/headers"];
}

// Notarize with the notarytool keychain profile only; without it
// electron-builder would silently skip notarization.
export function builderEnv(env) {
  if (!env.APPLE_KEYCHAIN_PROFILE) throw new Error("APPLE_KEYCHAIN_PROFILE missing from .env.contango.local");
  const out = { ...env };
  for (const k of STRIPPED_ENV) delete out[k];
  return out;
}

// Minimal dotenv: `export ` prefix, CRLF, `#` comment lines, matching
// surrounding quotes, and ` #` inline comments on unquoted values.
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value.match(/^(["'])(.*)\1$/);
    if (q) value = q[2];
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

export function loadEnvFile(path) {
  return parseEnvFile(readFileSync(path, "utf8"));
}

// Gate run after electron-builder: it skips signing (and with it
// notarization) with only a warning when no identity is usable.
export function verifyCommands(appPath) {
  return [
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]],
    ["xcrun", ["stapler", "validate", appPath]],
  ];
}

// `git status --porcelain --untracked-files=no` output: anything means
// tracked changes, so the build would not match the release tag.
export function assertCleanTree(porcelain) {
  const dirty = porcelain.split("\n").filter((line) => line.trim());
  if (dirty.length) throw new Error(`Working tree is dirty; commit or stash first:\n${dirty.join("\n")}`);
}

function main() {
  assertCleanTree(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: desktopRoot }).toString());
  const env = builderEnv({ ...process.env, ...loadEnvFile(join(desktopRoot, ".env.contango.local")) });
  const version = execFileSync("git", ["describe", "--tags", "--match", "v*-contango.*", "--exact-match"], { cwd: desktopRoot })
    .toString().trim().replace(/^v/, "");
  const dir = mkdtempSync(join(tmpdir(), "multica-contango-"));
  const entitlements = join(dir, "entitlements.plist");
  writeFileSync(entitlements, renderEntitlements(readFileSync(join(desktopRoot, "build/entitlements.contango.template.plist"), "utf8"), env));
  const config = join(dir, "electron-builder.json");
  writeFileSync(config, JSON.stringify(builderConfig(builderOverrides(env, entitlements), join(desktopRoot, "electron-builder.yml"), version), null, 2));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: desktopRoot, stdio: "inherit", env });
  run("pnpm", ["run", "build"]);
  const electronVersion = JSON.parse(readFileSync(join(desktopRoot, "node_modules/electron/package.json"), "utf8")).version;
  run("pnpm", addonBuildArgs(electronVersion));
  run("pnpm", ["exec", "electron-builder", "--mac", "--arm64", "--publish", "never", "--config", config]);
  for (const [cmd, args] of verifyCommands(join(desktopRoot, "dist/mac-arm64/Multica.app"))) run(cmd, args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
