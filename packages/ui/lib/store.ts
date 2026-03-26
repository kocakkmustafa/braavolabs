import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  token: string | null;
  tenantId: string | null;
  theme: "dark" | "light";
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
      setAuth: (token, tenantId) => set({ token, tenantId }),
      clearAuth: () => set({ token: null, tenantId: null }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === "dark" ? "light" : "dark" }),
    }),
    {
      name: "aicos-auth",
    },
  ),
);
