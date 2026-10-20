import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { planAllowsLocalProvider } from "./plan-entitlements";
import ContactPage from "../app/contact/page";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));

describe("current plans in the actual settings affordance", () => {
  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO"])("allows entitled current/compatible plan %s", plan => {
    expect(planAllowsLocalProvider(plan)).toBe(true);
  });
  it.each(["FREE", "BUSINESS", "ENTERPRISE", "MANUAL_REVIEW", "unknown", "__proto__"])("does not grant local routing to %s", plan => {
    expect(planAllowsLocalProvider(plan)).toBe(false);
  });
});

describe("actual contact page markup", () => {
  it("binds every visible form label to exactly one native control", () => {
    const html = renderToStaticMarkup(<ContactPage />);
    for (const field of ["name", "email", "topic", "message"]) {
      expect(html).toContain(`for="contact-${field}"`);
      expect(html.match(new RegExp(`id="contact-${field}"`, "g"))).toHaveLength(1);
    }
    expect(html).toMatch(/autoComplete="name"/i);
    expect(html).toMatch(/autoComplete="email"/i);
    expect(html).toContain('aria-describedby="contact-mail-draft"');
    expect(html).toContain('id="contact-mail-draft"');
  });
  it("uses the approved common support address and describes draft preparation", () => {
    const html = renderToStaticMarkup(<ContactPage />);
    expect(html).toContain('mailto:support@yulalab.com');
    expect(html).not.toContain('@braavolabs.com');
    expect(html).toContain("static.contact.draftHelp");
    expect(html).not.toContain("We reply within one business day");
  });
});
