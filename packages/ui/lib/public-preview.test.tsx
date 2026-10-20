import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import HomePage, { generateMetadata as homeMetadata } from "../app/page";
import PricingPage, { generateMetadata as pricingMetadata } from "../app/pricing/page";
import { locales } from "../i18n/locales";

const context = vi.hoisted(() => ({ locale: "en" }));
const messages = (locale: string) => JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));
vi.mock("next-intl/server", () => ({
  getLocale: async () => context.locale,
  getTranslations: async (namespace: string) => createTranslator({ locale: context.locale, messages: messages(context.locale), namespace }),
}));
vi.mock("../components/LanguageSwitcher", () => ({ default: () => <select aria-label="fixture-language" /> }));

describe("actual public async pages with all fourteen message catalogs", () => {
  it.each(locales)("renders localized truthful preview and USD plans for %s", async locale => {
    context.locale = locale;
    const t = createTranslator({ locale, messages: messages(locale), namespace: "publicPreview" });
    const home = renderToStaticMarkup(await HomePage());
    const pricing = renderToStaticMarkup(await PricingPage());
    expect(home).toContain(t("homeTitle"));
    expect(pricing).toContain(t("pricingTitle"));
    // Every priced card is a preview paragraph; it must not become a checkout.
    expect(pricing.match(/aria-label=/g)).toHaveLength(3);
    expect(pricing).not.toMatch(/<button|checkout|api\.stripe/i);
    expect(pricing).toContain(t("unavailable"));
    expect(home).toContain(t("inferenceFunding"));
    expect(pricing).toContain(t("inferenceFunding"));
    expect(home).not.toContain("publicPreview.");
    expect(pricing).not.toContain("publicPreview.");
    expect(home.match(/<bdi>/g)).toHaveLength(2);
    expect(pricing.match(/<bdi>/g)).toHaveLength(2);
    expect((await homeMetadata()).description).toBe(t("homeIntro"));
    expect((await pricingMetadata()).description).toBe(t("inferenceFunding"));
  });
});
