import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ONBOARDING_HANDOFF_KEY } from "./onboarding-handoff";

/**
 * Cookie-mode (D-007 / E9 web half). When the API runs with AUTH_COOKIE_MODE on,
 * the access + refresh JWTs live in httpOnly+Secure+SameSite cookies. The store
 * must then NOT mirror them into localStorage — that mirror is exactly the
 * XSS-readable surface we're removing. Gated by NEXT_PUBLIC_AUTH_COOKIE_MODE so
 * FE + API flip together; OFF = byte-for-byte today's bearer-from-storage flow.
 * The flag-ON path is verified in the coordinated live-login step (a real
 * browser + an API with the cookie flag on) — it can't be exercised headless.
 */
const COOKIE_MODE = process.env.NEXT_PUBLIC_AUTH_COOKIE_MODE === "true";

interface AppState {
  token: string | null;
  refreshToken: string | null;
  tenantId: string | null;
  sessionRevision: number;
  theme: "dark" | "light";
  _hydrated: boolean;
  setAuth: (token: string, tenantId: string, refreshToken?: string) => void;
  clearAuth: () => void;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
}

// Draft content belongs to a login session, not merely a shared tenant ID.
// Rehydration and same-owner refresh do not call this boundary cleanup.
function clearOnboardingSessionDraft() {
  try {
    localStorage.removeItem("aicos-onboarding-draft");
  } catch { /* private mode / unavailable browser storage */ }
  try {
    sessionStorage.removeItem("aicos-build-desc");
    sessionStorage.removeItem(ONBOARDING_HANDOFF_KEY);
  } catch { /* independent storage can remain accessible */ }
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      token: null,
      refreshToken: null,
      tenantId: null,
      sessionRevision: 0,
      theme: "dark",
      _hydrated: false,
      setAuth: (token, tenantId, refreshToken) => {
        clearOnboardingSessionDraft();
        set((state) => ({
        token, tenantId, refreshToken: refreshToken ?? null,
        sessionRevision: state.sessionRevision + 1,
      }));
      },
      clearAuth: () => {
        clearOnboardingSessionDraft();
        set((state) => ({
        token: null, tenantId: null, refreshToken: null,
        sessionRevision: state.sessionRevision + 1,
      }));
      },
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === "dark" ? "light" : "dark" }),
    }),
    {
      name: "aicos-auth",
      // OFF: persist the JWTs + tenantId + theme (today's behavior — bearer is
      // read back from storage on reload). ON: persist only non-sensitive UI
      // state; the httpOnly cookie carries auth across reloads, so the tokens
      // never touch localStorage. `_hydrated` + the action fns are transient
      // and excluded either way.
      partialize: (state) =>
        COOKIE_MODE
          ? { tenantId: state.tenantId, theme: state.theme }
          : {
              token: state.token,
              refreshToken: state.refreshToken,
              tenantId: state.tenantId,
              theme: state.theme,
            },
      onRehydrateStorage: () => (state) => {
        if (state) state._hydrated = true;
      },
    },
  ),
);

export interface AuthSessionSnapshot {
  readonly revision: number;
  readonly tenantId: string | null;
  readonly token: string | null;
  readonly refreshToken: string | null;
}

export function captureAuthSession(): AuthSessionSnapshot {
  const state = useAppStore.getState();
  return {
    revision: state.sessionRevision,
    tenantId: state.tenantId,
    token: state.token,
    refreshToken: state.refreshToken,
  };
}

export function isAuthSessionCurrent(session: AuthSessionSnapshot): boolean {
  const state = useAppStore.getState();
  return state.sessionRevision === session.revision && state.tenantId === session.tenantId;
}

/** Refresh preserves a session; a server-side tenant move creates a new boundary. */
export function refreshAuthSession(
  session: AuthSessionSnapshot,
  token: string,
  tenantId: string,
  refreshToken: string,
): boolean {
  if (!isAuthSessionCurrent(session)) return false;
  if (tenantId !== session.tenantId) clearOnboardingSessionDraft();
  useAppStore.setState({
    token, tenantId, refreshToken,
    sessionRevision: session.revision + (tenantId === session.tenantId ? 0 : 1),
  });
  return true;
}
