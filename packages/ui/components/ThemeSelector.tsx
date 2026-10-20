"use client";

import { useTranslations } from "next-intl";
import { useThemePreference } from "./ThemeProvider";
import type { ThemePreference } from "../lib/theme-preference";

export default function ThemeSelector() {
  const t = useTranslations("static.appearance");
  const { preference, setPreference, saveFailed } = useThemePreference();
  return (
    <div className="bv-theme-control">
      <label>
        <span>{t("label")}</span>
        <select value={preference} onChange={event => {
          const value = event.target.value;
          if (value === "system" || value === "light" || value === "dark") setPreference(value as ThemePreference);
        }}>
          {(["system", "light", "dark"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}
        </select>
      </label>
      {saveFailed && <p role="status">{t("saveFailed")}</p>}
    </div>
  );
}
