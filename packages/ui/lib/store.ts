import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  token: string | null;
  tenantId: string | null;
  theme: "dark" | "light";
  _hydrated: boolean;
  setAuth: (token: string, tenantId: string) => void;
  clearAuth: () => void;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      token: null,
      tenantId: null,
      theme: "dark",
      _hydrated: false,
      setAuth: (token, tenantId) => set({ token, tenantId }),
      clearAuth: () => set({ token: null, tenantId: null }),
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
