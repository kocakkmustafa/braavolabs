import {
  getCookieConsent,
  readStoredCookieConsent,
  subscribeCookieConsent,
  type CookieConsent,
} from "./cookie-consent";

export const ANALYTICS_SCRIPT_ID = "braavolabs-optional-analytics";
let documentAnalyticsStarted = false;

export interface AnalyticsBoundary {
  getConsent(): CookieConsent | null;
  readStoredConsent(): CookieConsent | null;
  subscribe(listener: () => void): () => void;
  hasScript(): boolean;
  hasStarted(): boolean;
  appendScript(domain: string): void;
  removeScript(): void;
  disableTracking(): void;
  reload(): void;
}

/** Browser boundaries are injected so tests cannot contact the tracker. */
export function startOptionalAnalytics(domain: string, boundary: AnalyticsBoundary): () => void {
  let revoked = false;
  let analyticsStarted = boundary.hasStarted();
  let reloadRequested = false;
  const sync = () => {
    if (!revoked && domain && boundary.getConsent() === "accepted") {
      if (!boundary.hasScript()) boundary.appendScript(domain);
      analyticsStarted = true;
      return;
    }
    if (!analyticsStarted) return;
    // Removing a script does not remove listeners it already installed.
    // Close the public event entry point, remove our script, then discard
    // those listeners with a reload only after storage no longer grants it.
    revoked = true;
    boundary.disableTracking();
    if (boundary.hasScript()) boundary.removeScript();
    try {
      if (!reloadRequested && boundary.readStoredConsent() !== "accepted") {
        reloadRequested = true;
        boundary.reload();
      }
    } catch { /* Reload could restore accepted: leave the runtime denied. */ }
  };
  const unsubscribe = boundary.subscribe(sync);
  sync();
  // The script belongs to the document, not a React mount. Effect cleanup
  // must not revoke consent or reload during React's development remount.
  return unsubscribe;
}

export function browserAnalyticsBoundary(): AnalyticsBoundary {
  return {
    getConsent: getCookieConsent,
    readStoredConsent: readStoredCookieConsent,
    subscribe: subscribeCookieConsent,
    hasScript: () => document.getElementById(ANALYTICS_SCRIPT_ID) !== null,
    hasStarted: () => documentAnalyticsStarted || document.getElementById(ANALYTICS_SCRIPT_ID) !== null,
    appendScript: domain => {
      documentAnalyticsStarted = true;
      const script = document.createElement("script");
      script.id = ANALYTICS_SCRIPT_ID;
      script.defer = true;
      script.dataset.domain = domain;
      script.src = "https://plausible.io/js/script.outbound-links.js";
      document.head.appendChild(script);
    },
    removeScript: () => document.getElementById(ANALYTICS_SCRIPT_ID)?.remove(),
    disableTracking: () => {
      // Disable future calls through the public global entry point. The
      // reload above is needed for vendor-owned listeners/closures.
      (window as Window & { plausible?: (...args: unknown[]) => void }).plausible = () => {};
    },
    reload: () => window.location.reload(),
  };
}
