"use client";

import { useLocale } from "next-intl";
import { currentTimeZone, formatCurrency, formatDateTime, formatDurationMs, formatNumber } from "../i18n/locales";

/** Formatting changes presentation, never the record's currency or instant. */
export function useDisplayFormats() {
  const locale = useLocale();
  return {
    number: (value: unknown, maximumFractionDigits = 2) => formatNumber(value, locale, { maximumFractionDigits }),
    usd: (value: unknown, maximumFractionDigits = 4) => formatCurrency(value, "USD", locale, { maximumFractionDigits }),
    duration: (milliseconds: unknown) => formatDurationMs(milliseconds, locale),
    time: (value: Date | string | number | null | undefined) => formatDateTime(value, locale, { timeZone: currentTimeZone(), timeStyle: "medium" }),
  };
}
