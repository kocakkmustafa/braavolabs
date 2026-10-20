export type CookieConsent = "accepted" | "essential-only";
export const COOKIE_CONSENT_KEY = "cookie_consent";

const listeners = new Set<() => void>();
// A failed storage write must never grant analytics in this document.
let runtimeChoice: CookieConsent | null | undefined;
let runtimeRevoked = false;

export function readStoredCookieConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(COOKIE_CONSENT_KEY);
  return value === "accepted" || value === "essential-only" ? value : null;
}

export function getCookieConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const choice = runtimeChoice !== undefined ? runtimeChoice : readStoredCookieConsent();
    return runtimeRevoked && choice === "accepted" ? null : choice;
  } catch { return null; }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === COOKIE_CONSENT_KEY) {
    runtimeChoice = undefined;
    notify();
  }
}

export function subscribeCookieConsent(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setCookieConsent(choice: CookieConsent): boolean {
  if (typeof window === "undefined") return false;
  let saved = false;
  try {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, choice);
    saved = readStoredCookieConsent() === choice;
  } catch { /* Storage may be unavailable. Keep analytics disabled. */ }
  runtimeChoice = saved ? choice : null;
  runtimeRevoked = !saved || choice !== "accepted";
  notify();
  return saved;
}

/** Revoke in this document immediately; report whether storage was cleared. */
export function clearCookieConsent(): boolean {
  if (typeof window === "undefined") return false;
  runtimeChoice = null;
  runtimeRevoked = true;
  let cleared = false;
  try {
    window.localStorage.removeItem(COOKIE_CONSENT_KEY);
    cleared = window.localStorage.getItem(COOKIE_CONSENT_KEY) === null;
  } catch { /* The caller must show a failure rather than claim success. */ }
  notify();
  return cleared;
}
