import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createTranslator } from "next-intl";
import { jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as formats from "../i18n/locales";

/** Exercise the actual private chip function without mounting the route or
 * invoking its account/API effects. Only locale/hooks/import boundaries fake. */
function chip(locale: string) {
  const source = readFileSync(resolve("app/pipelines/[id]/page.tsx"), "utf8");
  const compiled = ts.transpileModule(source + "\nexport const estimateFixture = CostEstimateChip;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports: any = {};
  runInNewContext(compiled, { exports, process: { env: {} }, require: (name: string) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs };
    if (name.endsWith("/useDisplayFormats")) return { useDisplayFormats: () => ({ usd: (value: unknown) => formats.formatCurrency(value, "USD", locale, { maximumFractionDigits: 4 }) }) };
    return new Proxy({}, { get: () => () => null });
  } });
  const messages = JSON.parse(readFileSync(resolve(`messages/${locale}.json`), "utf8"));
  const t = createTranslator({ locale, messages, onError: error => { throw error; } });
  return { t, render: (estimate: any, failed = false) => renderToStaticMarkup(exports.estimateFixture({ estimate, failed, t })) };
}

describe("actual cost-estimate chip and legacy zero placeholders", () => {
  for (const locale of formats.locales) {
    it(`${locale}: an unknown endpoint price cannot become a free or zero estimate`, () => {
      const { t, render } = chip(locale);
      const html = render({ lowUsd: 0, highUsd: 0, unknownModel: true, isFree: true, configured: true, model: "fixture" });
      const expected = renderToStaticMarkup(jsx("span", { children: t("app.cost.estimateUnknown") })).slice(6, -7);
      expect(html).toContain(expected); expect(html).not.toContain(t("app.cost.estimateFree")); expect(html).not.toContain("fixture");
    });
    it(`${locale}: configured known zero remains an explicitly labeled estimate`, () => {
      const { t, render } = chip(locale), amount = formats.formatCurrency(0, "USD", locale, { maximumFractionDigits: 4 });
      const html = render({ lowUsd: 0, highUsd: 0, unknownModel: false, isFree: true, configured: true, model: "fixture-model" });
      expect(html).toContain(amount); expect(html).toContain("fixture-model"); expect(html).not.toContain(t("app.cost.estimateFree"));
    });
  }
});
