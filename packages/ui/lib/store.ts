import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  theme: "dark" | "light";
  _hydrated: boolean;
  setAuth: (token: string, tenantId: string, refreshToken?: string) => void;
  clearAuth: () => void;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      token: null,
      refreshToken: null,
      tenantId: null,
      theme: "dark",
      _hydrated: false,
      setAuth: (token, tenantId, refreshToken) => set({ token, tenantId, refreshToken: refreshToken ?? null }),
      clearAuth: () => set({ token: null, tenantId: null, refreshToken: null }),
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
