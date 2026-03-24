import { create } from "zustand";

interface AppState {
  token: string | null;
  tenantId: string | null;
  setAuth: (token: string, tenantId: string) => void;
  clearAuth: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  token: null,
  tenantId: null,
  setAuth: (token, tenantId) => set({ token, tenantId }),
  clearAuth: () => set({ token: null, tenantId: null }),
}));
