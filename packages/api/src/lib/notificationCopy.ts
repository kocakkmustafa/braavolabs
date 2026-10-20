import copy from "./notificationCopy.json";
import { resolveNotificationLocale } from "./notificationLocale";

export type NotificationCopyKey = keyof typeof copy.en;
export type NotificationParameters = Record<string, string | number>;
export interface NotificationDescriptor {
  title: NotificationCopyKey;
  body?: NotificationCopyKey;
  parameters?: NotificationParameters;
}

/** Plain text only. HTML callers escape after interpolation; values are not recursive. */
export function notificationText(locale: unknown, key: NotificationCopyKey, parameters: NotificationParameters = {}): string {
  const language = resolveNotificationLocale(locale);
  return copy[language][key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = parameters[name];
    if (value === undefined) return placeholder;
    if (typeof value !== "number") return value;
    if (!Number.isFinite(value)) return "—";
    const digits = name === "costUsd" ? 4 : name === "budgetUsd" ? 2 : 0;
    return new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  });
}

/** Copy selection never changes policy checks, stored diagnostics or run state. */
export function governanceReasonCopy(result: {
  stopType?: string;
  details?: Record<string, unknown>;
}, thresholdFraction: number): { key: NotificationCopyKey; parameters: NotificationParameters } | undefined {
  const details = result.details ?? {};
  switch (result.stopType) {
    case "cost_anomaly_stop":
      if (typeof details.currentCost === "number" && typeof details.budget === "number") {
        return { key: "riskReason.cost", parameters: { costUsd: details.currentCost, budgetUsd: details.budget, percent: thresholdFraction * 100 } };
      }
      return undefined;
    case "loop_stop":
      return typeof details.consecutiveFailures === "number" ? { key: "riskReason.failures", parameters: { count: details.consecutiveFailures } } : undefined;
    case "spam_stop":
      return typeof details.count === "number" && typeof details.target === "string" ? { key: "riskReason.spam", parameters: { count: details.count, target: details.target } } : undefined;
    case "brand_violation_stop":
      return typeof details.pattern === "string" ? { key: "riskReason.brand", parameters: { pattern: details.pattern } } : undefined;
    case "hard_stop":
      return { key: "riskReason.manual", parameters: {} };
    default:
      return undefined;
  }
}
