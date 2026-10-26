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
// electron-builder picks these over APPLE_KEYCHAIN_PROFILE when present.
const OTHER_NOTARY_CREDENTIALS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];

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
  };
}

// Notarize with the notarytool keychain profile only; without it
// electron-builder would silently skip notarization.
export function builderEnv(env) {
  if (!env.APPLE_KEYCHAIN_PROFILE) throw new Error("APPLE_KEYCHAIN_PROFILE missing from .env.contango.local");
  const out = { ...env };
  for (const k of OTHER_NOTARY_CREDENTIALS) delete out[k];
  return out;
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
  run("pnpm", ["exec", "electron-builder", "--mac", "--arm64", "--publish", "never", "--config", config]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
