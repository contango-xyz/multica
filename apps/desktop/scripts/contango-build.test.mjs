import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEntitlements, builderOverrides, builderConfig, builderEnv, parseEnvFile, verifyCommands, assertCleanTree, addonBuildArgs } from "./contango-build.mjs";

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

test("overrides keep multica:// and add http(s) as a viewer", () => {
  const o = builderOverrides(env, "/tmp/ent.plist");
  assert.deepEqual(o.protocols, [
    { name: "Multica", schemes: ["multica"] },
    { name: "Web links", schemes: ["https", "http"], role: "Viewer" },
  ]);
  assert.deepEqual(builderConfig(o, "/x", "1").protocols, o.protocols);
});

test("missing variable fails loudly", () => {
  assert.throws(() => builderOverrides({ ...env, CONTANGO_APP_ID: "" }, "/tmp/e"), /CONTANGO_APP_ID/);
});

// electron-builder deep-merges an object `publish` (from -c.publish.* or an
// extending config) into upstream's github publish, keeping owner/repo. An
// array replaces it outright, so app-update.yml carries only our feed.
test("generated config extends the base and replaces publish", () => {
  const c = builderConfig(builderOverrides(env, "/tmp/ent.plist"), "/x/electron-builder.yml", "0.7.0-contango.3");
  assert.equal(c.extends, "/x/electron-builder.yml");
  assert.equal(c.appId, "com.example.desktop");
  assert.deepEqual(c.extraMetadata, { version: "0.7.0-contango.3" });
  assert.deepEqual(c.mac, { entitlements: "/tmp/ent.plist", provisioningProfile: "/tmp/p.provisionprofile", notarize: true,
    extraResources: [{ from: "native/push-click/build/Release/push_click.node", to: "push-click.node" }] });
  assert.deepEqual(c.publish, [{ provider: "generic", url: "https://srv.example.test/desktop/", channel: "contango" }]);
});

// electron-builder prefers APPLE_ID / APPLE_API_KEY credentials over a
// keychain profile and silently skips notarization when none is set.
test("notarization uses only the keychain profile", () => {
  const e = builderEnv({ ...env, APPLE_KEYCHAIN_PROFILE: "notary", APPLE_ID: "a@b", APPLE_APP_SPECIFIC_PASSWORD: "x",
    APPLE_API_KEY: "k", APPLE_API_KEY_ID: "i", APPLE_API_ISSUER: "s", CSC_IDENTITY_AUTO_DISCOVERY: "false", PATH: "/bin" });
  assert.equal(e.APPLE_KEYCHAIN_PROFILE, "notary");
  assert.equal(e.PATH, "/bin");
  // reaches `pnpm run build`, where electron.vite.config.ts bakes it in
  assert.equal(e.CONTANGO_APP_ID, "com.example.desktop");
  assert.equal(e.CONTANGO_API_URL, "https://srv.example.test");
  for (const k of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "CSC_IDENTITY_AUTO_DISCOVERY"]) {
    assert.equal(k in e, false, k);
  }
  assert.throws(() => builderEnv(env), /APPLE_KEYCHAIN_PROFILE/);
});

test("env file: quotes, CRLF, comments, export", () => {
  const text = [
    "# comment line",
    'CONTANGO_API_URL="https://srv.example.test"',
    "CONTANGO_APP_ID='com.example.desktop'\r",
    "export CONTANGO_TEAM_ID=ABCDE12345",
    "CONTANGO_UPDATE_URL=https://srv.example.test/desktop/ # feed",
    'QUOTED_HASH="a #b"',
    "EMPTY=",
    "",
  ].join("\n");
  assert.deepEqual(parseEnvFile(text), {
    CONTANGO_API_URL: "https://srv.example.test",
    CONTANGO_APP_ID: "com.example.desktop",
    CONTANGO_TEAM_ID: "ABCDE12345",
    CONTANGO_UPDATE_URL: "https://srv.example.test/desktop/",
    QUOTED_HASH: "a #b",
    EMPTY: "",
  });
});

test("server and feed URLs must be http(s)", () => {
  assert.throws(() => builderOverrides({ ...env, CONTANGO_API_URL: '"https://srv.example.test"' }, "/tmp/e"), /CONTANGO_API_URL/);
  assert.throws(() => builderOverrides({ ...env, CONTANGO_UPDATE_URL: "ftp://srv.example.test/" }, "/tmp/e"), /CONTANGO_UPDATE_URL/);
});

test("post-build gate verifies signature and stapled ticket", () => {
  assert.deepEqual(verifyCommands("/d/Multica.app"), [
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", "/d/Multica.app"]],
    ["xcrun", ["stapler", "validate", "/d/Multica.app"]],
  ]);
});

// A release tag must equal the shipped code.
test("a clean tree passes", () => {
  assert.doesNotThrow(() => assertCleanTree(""));
  assert.doesNotThrow(() => assertCleanTree("\n"));
});

test("tracked changes refuse the build and name the files", () => {
  assert.throws(() => assertCleanTree(" M apps/desktop/src/main/index.ts\nA  docs/x.md\n"), /dirty.*index\.ts.*docs\/x\.md/s);
});

test("fuses close the Node entry points into the signed app", () => {
  const o = builderOverrides(env, "/tmp/ent.plist");
  assert.deepEqual(o.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
  });
  assert.deepEqual(builderConfig(o, "/x", "1").electronFuses, o.electronFuses);
});

// Upstream's top-level extraResources (LICENSE, NOTICE) stay: electron-builder
// adds mac.extraResources to them, and only the push-click addon is added.
test("push-click addon ships in Resources, built for the installed Electron", () => {
  const c = builderConfig(builderOverrides(env, "/tmp/ent.plist"), "/x/electron-builder.yml", "1");
  assert.equal("extraResources" in c, false);
  assert.deepEqual(c.mac.extraResources, [{ from: "native/push-click/build/Release/push_click.node", to: "push-click.node" }]);
  assert.deepEqual(addonBuildArgs("44.9.3"), ["exec", "node-gyp", "rebuild", "--directory", "native/push-click",
    "--target=44.9.3", "--arch=arm64", "--dist-url=https://electronjs.org/headers"]);
});
