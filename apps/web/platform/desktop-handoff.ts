const OPEN_IN_DESKTOP_KEY = "multica:open-links-in-desktop";
const CHECKED_IN_TAB_KEY = "multica:desktop-handoff-checked";

export function handoffUrl(pathname: string, search: string, hash: string): string {
  return `multica://open?path=${encodeURIComponent(pathname + search + hash)}`;
}

function isSameOrigin(referrer: string, origin: string): boolean {
  try {
    return referrer !== "" && new URL(referrer).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Only the first page of a fresh navigation in a tab hands off; reloads, history
 * moves, returns from other sites (checkedInTab) and same-site new tabs
 * (own-origin referrer) stay in the browser.
 */
export function shouldHandOff({
  enabled,
  navigationType,
  alreadyHandled,
  checkedInTab,
  referrer,
  origin,
}: {
  enabled: boolean;
  navigationType: string | undefined;
  alreadyHandled: boolean;
  checkedInTab: boolean;
  referrer: string;
  origin: string;
}): boolean {
  return (
    enabled &&
    navigationType === "navigate" &&
    !alreadyHandled &&
    !checkedInTab &&
    !isSameOrigin(referrer, origin)
  );
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

export function readCheckedInTab(): boolean {
  try {
    return sessionStorage.getItem(CHECKED_IN_TAB_KEY) === "true";
  } catch {
    return false;
  }
}

export function markCheckedInTab(): void {
  try {
    sessionStorage.setItem(CHECKED_IN_TAB_KEY, "true");
  } catch {
    // Not persisted; a later load in this tab may check again.
  }
}

export function openDesktopApp(url: string): void {
  window.location.href = url;
}
