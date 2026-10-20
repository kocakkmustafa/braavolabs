import { describe, expect, it } from "vitest";
import copy from "./notificationCopy.json";
import { governanceReasonCopy, notificationText, type NotificationCopyKey } from "./notificationCopy";
import { NOTIFICATION_LOCALES, normalizeNotificationLocale, notificationLocaleFromHeader } from "./notificationLocale";

describe("bounded notification presentation preference", () => {
  it.each(NOTIFICATION_LOCALES)("preserves the canonical explicit app choice %s", locale => {
    expect(normalizeNotificationLocale(locale)).toBe(locale);
    expect(notificationLocaleFromHeader(locale)).toBe(locale);
  });
  it.each([["es-MX", "es-419"], ["pt_PT", "pt-BR"], ["zh-CN", "zh-Hans"], ["zh-Hans-SG", "zh-Hans"], ["ar-SA", "ar"], ["ko-Hang-KR", "ko"]])("normalizes supported regional choice %s", (input, expected) => {
    expect(normalizeNotificationLocale(input)).toBe(expected);
  });
  it.each(["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "ar-Latn", "hi-Latn", "en-Cyrl", "zz", "<script>", "a".repeat(65), null])("does not advertise an unsupported script or malformed tag: %s", input => {
    expect(normalizeNotificationLocale(input)).toBeNull();
  });
  it("honors quality ordering, stable ties, exclusions and bounded malformed input", () => {
    expect(notificationLocaleFromHeader("zh-Hant;q=1,fr;q=0.8,tr;q=0.9")).toBe("tr");
    expect(notificationLocaleFromHeader("fr;q=0.8,tr;q=0.8")).toBe("fr");
    expect(notificationLocaleFromHeader("tr;q=0,ja;q=1.1,ar;q=0.3")).toBe("ar");
    expect(notificationLocaleFromHeader("tr;q=oops,zh-Hant,*")).toBe("en");
    expect(notificationLocaleFromHeader("x".repeat(8193))).toBe("en");
    expect(notificationLocaleFromHeader(Array(50).fill("zz").join(",") + ",tr")).toBe("en");
    expect(notificationLocaleFromHeader(["ar"])).toBe("en");
  });
});

describe("complete notification catalogue contracts", () => {
  const keys = Object.keys(copy.en) as NotificationCopyKey[];
  const parameters = { firstName: "<untrusted>{tenantName}", tenantName: "Research & Design", toolName: "tool.raw_id", stopType: "loop_stop", count: 2, target: "user@example.invalid", pattern: "do-not-translate", costUsd: 1.2345, budgetUsd: 10, percent: 80 };
  const placeholders = (value: string) => Array.from(value.matchAll(/\{(\w+)\}/g), match => match[1]).sort();
  it.each(NOTIFICATION_LOCALES)("keeps all 41 keys and parameter names in %s", locale => {
    expect(keys).toHaveLength(41);
    expect(Object.keys(copy[locale]).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(copy[locale][key].trim().length).toBeGreaterThan(0);
      expect(placeholders(copy[locale][key])).toEqual(placeholders(copy.en[key]));
      const rendered = notificationText(locale, key, parameters);
      expect(rendered).not.toMatch(/\{(?:count|costUsd|budgetUsd|percent|toolName|stopType|pattern|target)\}/);
    }
    expect(notificationText(locale, "welcome.heading", parameters)).toContain("<untrusted>{tenantName}");
    expect(notificationText(locale, "push.toolApprovalBody", parameters)).toContain("tool.raw_id");
    expect(notificationText(locale, "riskReason.cost", parameters)).toContain(new Intl.NumberFormat(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(1.2345));
    expect(notificationText(locale, "riskReason.failures", { count: Number.NaN })).toContain("—");
  });
  it("selects all five actual authored governance reasons without changing diagnostic identifiers", () => {
    expect(governanceReasonCopy({ stopType: "cost_anomaly_stop", details: { currentCost: 8, budget: 10 } }, 0.8)).toEqual({ key: "riskReason.cost", parameters: { costUsd: 8, budgetUsd: 10, percent: 80 } });
    expect(governanceReasonCopy({ stopType: "loop_stop", details: { consecutiveFailures: 3 } }, 0.8)).toEqual({ key: "riskReason.failures", parameters: { count: 3 } });
    expect(governanceReasonCopy({ stopType: "spam_stop", details: { count: 4, target: "raw-recipient" } }, 0.8)).toEqual({ key: "riskReason.spam", parameters: { count: 4, target: "raw-recipient" } });
    expect(governanceReasonCopy({ stopType: "brand_violation_stop", details: { pattern: "raw pattern" } }, 0.8)).toEqual({ key: "riskReason.brand", parameters: { pattern: "raw pattern" } });
    expect(governanceReasonCopy({ stopType: "hard_stop" }, 0.8)).toEqual({ key: "riskReason.manual", parameters: {} });
    expect(governanceReasonCopy({ stopType: "cost_anomaly_stop", details: {} }, 0.8)).toBeUndefined();
    expect(governanceReasonCopy({ stopType: "external_unrecognized" }, 0.8)).toBeUndefined();
  });
});
