export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export const THEME_STORAGE_KEY = "braavo-theme";

/** Self-contained so the exact same code runs before paint and after hydration.
 * Only the legacy theme field is migrated; auth values are never copied. */
export function initializeTheme(
  view: Pick<Window, "localStorage" | "matchMedia">,
  root: HTMLElement,
  override?: ThemePreference,
): { preference: ThemePreference; resolved: ResolvedTheme } {
  let preference: ThemePreference = override ?? "system";
  if (override === undefined) {
    try {
      const stored = view.localStorage.getItem("braavo-theme");
      if (stored === "light" || stored === "dark" || stored === "system") preference = stored;
      else {
        const legacy = JSON.parse(view.localStorage.getItem("aicos-auth") ?? "null")?.state?.theme;
        if (legacy === "light" || legacy === "dark") preference = legacy;
      }
    } catch { /* A blocked/corrupt preference falls back to system. */ }
  }
  let prefersDark = true;
  try { prefersDark = view.matchMedia("(prefers-color-scheme: dark)").matches; }
  catch { /* No media API: use the server's dark fallback. */ }
  const resolved = preference === "system" ? (prefersDark ? "dark" : "light") : preference;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.style.colorScheme = resolved;
  root.dataset.theme = preference;
  root.dataset.resolvedTheme = resolved;
  return { preference, resolved };
}

// No request/user values are interpolated into this script.
export const THEME_INIT_SCRIPT = `(${initializeTheme.toString()})(window,document.documentElement);`;

export function persistThemePreference(storage: Pick<Storage, "setItem" | "getItem">, preference: ThemePreference): boolean {
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
    return storage.getItem(THEME_STORAGE_KEY) === preference;
  } catch { return false; }
}
