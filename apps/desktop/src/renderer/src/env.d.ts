/// <reference types="vite/client" />

// Fork builds bake the bundle id in (electron.vite.config.ts); "" on upstream
// builds, and undefined under vitest, so use sites guard with `typeof`.
declare const __CONTANGO_APP_ID__: string;
