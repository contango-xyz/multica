// Load check for the compiled push-click addon in real Electron (macOS), after
// `pnpm exec node-gyp rebuild --directory native/push-click --target=<electron
// version> --arch=arm64 --dist-url=https://electronjs.org/headers`:
//   pnpm exec electron scripts/push-click-smoke.mjs
// Exits 0 when the addon refuses to start without Electron's notification
// delegate, starts once it exists, and refuses a second start.
import { app, Notification } from "electron";
import { join } from "node:path";

app.whenReady().then(() => {
  const mod = { exports: {} };
  process.dlopen(mod, join(import.meta.dirname, "../native/push-click/build/Release/push_click.node"));
  const { start } = mod.exports;
  const beforeDelegate = start(() => {});
  Notification.isSupported();
  const afterDelegate = start(() => {});
  const second = start(() => {});
  console.log(JSON.stringify({ beforeDelegate, afterDelegate, second }));
  app.exit(beforeDelegate === false && afterDelegate === true && second === false ? 0 : 1);
});
