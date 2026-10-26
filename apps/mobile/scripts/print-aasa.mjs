#!/usr/bin/env node
// Prints the apple-app-site-association file the server must serve at
// https://<EXPO_ASSOCIATED_DOMAIN>/.well-known/apple-app-site-association.
// Values come from env (git-ignored .env.production.local or the EAS
// production environment), never from the repo:
//   dotenv -e .env.production.local -- node scripts/print-aasa.mjs
// Paths come from lib/universal-links.ts so the file always matches what the
// app maps (Node strips the TypeScript types).
import { AASA_EXCLUDED_PATHS, AASA_PATHS } from "../lib/universal-links.ts";

const team = process.env.EXPO_APPLE_TEAM_ID;
const bundle = process.env.EXPO_BUNDLE_IDENTIFIER_PROD;
if (!team || !bundle) {
  console.error("Set EXPO_APPLE_TEAM_ID and EXPO_BUNDLE_IDENTIFIER_PROD.");
  process.exit(1);
}

const components = [
  ...AASA_EXCLUDED_PATHS.map((path) => ({ "/": path, exclude: true })),
  ...AASA_PATHS.map((path) => ({ "/": path })),
];

console.log(
  JSON.stringify({ applinks: { details: [{ appIDs: [`${team}.${bundle}`], components }] } }, null, 2),
);
