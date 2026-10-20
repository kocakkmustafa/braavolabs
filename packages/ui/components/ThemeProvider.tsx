"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { initializeTheme, persistThemePreference, THEME_STORAGE_KEY, type ThemePreference, type ResolvedTheme } from "../lib/theme-preference";

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  saveFailed: boolean;
  setPreference: (preference: ThemePreference) => void;
}
const ThemeContext = createContext<ThemeState | null>(null);

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ preference: ThemePreference; resolved: ResolvedTheme }>({ preference: "system", resolved: "dark" });
  const [saveFailed, setSaveFailed] = useState(false);
  const preferenceRef = useRef<ThemePreference>("system");
  const localChoiceMade = useRef(false);
  const apply = useCallback((preference?: ThemePreference) => {
    const next = initializeTheme(window, document.documentElement, preference);
    preferenceRef.current = next.preference;
    setState(next);
  }, []);

  useEffect(() => {
    apply();
    const onStorage = (event: StorageEvent) => {
      if (event.key === "aicos-auth" && localChoiceMade.current) return;
      if (event.key === null || event.key === THEME_STORAGE_KEY || event.key === "aicos-auth") {
        setSaveFailed(false);
        apply();
      }
    };
    const onSystemChange = () => { if (preferenceRef.current === "system") apply("system"); };
    let media: MediaQueryList | undefined;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
      if (media.addEventListener) media.addEventListener("change", onSystemChange);
      else media.addListener(onSystemChange);
    }
    catch { /* Explicit light/dark still works without a media API. */ }
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      if (media?.removeEventListener) media.removeEventListener("change", onSystemChange);
      else media?.removeListener(onSystemChange);
    };
  }, [apply]);

  const setPreference = useCallback((preference: ThemePreference) => {
    localChoiceMade.current = true;
    apply(preference);
    let saved = false;
    try { saved = persistThemePreference(window.localStorage, preference); } catch { /* Storage getter can throw. */ }
    setSaveFailed(!saved);
  }, [apply]);

  return <ThemeContext.Provider value={{ ...state, saveFailed, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useThemePreference(): ThemeState {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("Theme controls require ThemeProvider");
  return context;
}
