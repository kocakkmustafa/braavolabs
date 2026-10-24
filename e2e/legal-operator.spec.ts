import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { UI } from "./ports";

// BRV-21: every legal page shows the one published operator record (lib/legal-operator.ts)
// with localized labels, inside its existing section (no extra heading / TOC entry).
const source = readFileSync(join(process.cwd(), "packages/ui/lib/legal-operator.ts"), "utf8");
const field = (name: string) => source.match(new RegExp(`\\b${name}: "([^"]+)"`))![1];
const RECORD = { legalName: field("legalName"), controller: field("controller"), address: `${field("address")}, ${field("country")}` };
const labels = (locale: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "packages/ui/messages", `${locale}.json`), "utf8")).static.common.legalOperator;

for (const path of ["/privacy", "/terms", "/kvkk", "/gdpr", "/legal/account-deletion"]) {
  for (const locale of ["en", "tr", "ar"]) {
    test(`legal operator record on ${path} (${locale})`, async ({ context, page }) => {
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: UI }]);
      await context.addInitScript(() => localStorage.setItem("cookie_consent", "essential-only"));
      await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
      const response = await page.goto(UI + path);
      expect(response?.status()).toBe(200);
      const block = page.locator("address[data-legal-operator]");
      await expect(block).toHaveCount(1);
      const copy = labels(locale);
      const rows = await block.locator(":scope > span").allInnerTexts();
      expect(rows.map((row) => row.replace(/\s+/g, " ").trim())).toEqual([
        `${copy.operator}: ${RECORD.legalName}`,
        `${copy.controller}: ${RECORD.controller}`,
        `${copy.address}: ${RECORD.address}`,
      ]);
      // Values keep their own direction inside RTL text.
      await expect(block.locator("bdi")).toHaveCount(3);
      // The record lives inside an existing section, not under a heading of its own.
      expect(await block.evaluate((node) => node.closest("section, article, div")?.querySelector("h2") !== null)).toBe(true);
    });
  }
}
