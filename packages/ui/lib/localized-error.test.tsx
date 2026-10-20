import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunStepHeatmap } from "../components/RunStepHeatmap";
import { classifyFailure, LocalizedUiError, useLocalizedFailure } from "./localized-error";
import { timeAgo } from "./timeAgo";
import { locales } from "../i18n/locales";

const context = vi.hoisted(() => ({ locale: "en" }));
vi.mock("next-intl", async () => {
  const actual = await vi.importActual<typeof import("next-intl")>("next-intl");
  return { ...actual, useLocale: () => context.locale, useTranslations: (namespace: string) => actual.createTranslator({
    locale: context.locale, namespace,
    messages: JSON.parse(readFileSync(new URL(`../messages/${context.locale}.json`, import.meta.url), "utf8")),
    onError: error => { throw error; },
  }) };
});
beforeEach(() => { context.locale = "en"; });

describe("safe localized error envelopes", () => {
  it.each([[401, "session"], [403, "forbidden"], [429, "rateLimit"], [408, "timeout"], [504, "timeout"], [500, "generic"]])("classifies HTTP %s without displaying its body", (status, kind) => {
    const error = Object.assign(new Error("PRIVATE_UPSTREAM_DETAIL"), { status });
    expect(classifyFailure(error)).toBe(kind);
    expect(useLocalizedFailure()(error, "Action failed")).not.toContain("PRIVATE_UPSTREAM_DETAIL");
  });
  it("recognizes the real deadline code and retains uncertain-outcome guidance", () => {
    const message = useLocalizedFailure()({ code: "REQUEST_TIMEOUT", message: "PRIVATE" });
    expect(message).toContain("outcome may be uncertain"); expect(message).toContain("before retrying");
  });
  it("does not promote an arbitrary provider message to a trusted local control-flow error", () => {
    const describe = useLocalizedFailure();
    expect(describe({ name: "LocalizedUiError", message: "PRIVATE_STACK_PATH" }, "Action failed")).toBe("Action failed");
    expect(describe(new LocalizedUiError("Locally translated polling limit"))).toBe("Locally translated polling limit");
    expect(classifyFailure(new TypeError("Failed to fetch"))).toBe("network");
  });
  it.each(locales)("formats past/future and invalid relative timestamps in %s", locale => {
    const now = Date.UTC(2026, 9, 20, 12);
    expect(timeAgo(new Date(now - 120_000).toISOString(), locale, now)).toBe(new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-2, "minute"));
    expect(timeAgo(new Date(now + 120_000).toISOString(), locale, now)).toBe(new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(2, "minute"));
    expect(timeAgo("not-a-date", locale, now)).toBe("—"); expect(timeAgo(undefined, locale, now)).toBe("—");
  });
});

describe("actual step heatmap's unknown and zero presentation", () => {
  it.each([undefined, null, "", "n/a", "2USD", false, true, {}, [], NaN, Infinity, -1].map(value => ({ value })))("does not fabricate zero cost for $value", ({ value }) => {
    const html = renderToStaticMarkup(<RunStepHeatmap steps={[{ id: "fixture", stepIndex: 0, costUsd: value as number, status: "COMPLETED" }]} />);
    expect(html).toContain("cost — duration —"); expect(html).not.toContain("$0");
  });
  it("preserves known zero cost and zero duration", () => {
    const html = renderToStaticMarkup(<RunStepHeatmap steps={[{ id: "fixture", stepIndex: 0, costUsd: 0, durationMs: 0 }]} />);
    expect(html).toContain("cost $0"); expect(html).toContain("duration 0 ms");
  });
  it("keeps an incomplete total unknown while showing a known step", () => {
    const html = renderToStaticMarkup(<RunStepHeatmap steps={[{ id: "a", stepIndex: 0, costUsd: 1, durationMs: 10 }, { id: "b", stepIndex: 1 }]} />);
    expect(html).toContain("cost $1"); expect(html).toContain("cost —");
    expect(html).toContain('class="bv-mono">—</span>');
  });
});
