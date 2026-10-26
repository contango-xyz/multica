const OPEN_IN_DESKTOP_KEY = "multica:open-links-in-desktop";

export function handoffUrl(pathname: string, search: string, hash: string): string {
  return `multica://open?path=${encodeURIComponent(pathname + search + hash)}`;
}

/** Only the first page of a fresh navigation hands off; reloads and history moves stay in the browser. */
export function shouldHandOff({
  enabled,
  navigationType,
  alreadyHandled,
}: {
  enabled: boolean;
  navigationType: string | undefined;
  alreadyHandled: boolean;
}): boolean {
  return enabled && navigationType === "navigate" && !alreadyHandled;
}

// Storage access throws in some private-browsing modes; treat that as "off".
export function readOpenInDesktop(): boolean {
  try {
    return localStorage.getItem(OPEN_IN_DESKTOP_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeOpenInDesktop(value: boolean): void {
  try {
    localStorage.setItem(OPEN_IN_DESKTOP_KEY, String(value));
  } catch {
    // Not persisted; the setting stays off for this browser.
  }
}

export function openDesktopApp(url: string): void {
  window.location.href = url;
}
