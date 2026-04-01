import { create } from "zustand";
import { persist } from "zustand/middleware";

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
      onRehydrateStorage: () => (state) => {
        if (state) state._hydrated = true;
      },
    },
  ),
);
