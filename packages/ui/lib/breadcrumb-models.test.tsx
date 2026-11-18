import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/models" }));

import Breadcrumb, { ROUTE_LABEL_KEYS } from "../components/Breadcrumb";

const dir = join(__dirname, "../messages");
const load = (l: string) => JSON.parse(readFileSync(join(dir, `${l}.json`), "utf8"));
const render = (locale: string) => renderToStaticMarkup(
  <NextIntlClientProvider locale={locale} messages={load(locale)}><Breadcrumb /></NextIntlClientProvider>,
);

describe("BRA-UX-05h-b: breadcrumb 'models' kabuk eşlemesiyle çevrilir", () => {
  it("eşleme app.breadcrumb.models'e gider", () => {
    expect(ROUTE_LABEL_KEYS.models).toBe("app.breadcrumb.models");
  });
  it("tr/en/ja çevrilmiş etiket, ham 'models' yok", () => {
    expect(render("tr")).toContain(">Modeller<");
    expect(render("en")).toContain(">Models<");
    expect(render("ja")).toContain(">モデル<");
    for (const l of ["tr", "ja", "ar", "zh-Hans"]) expect(render(l)).not.toContain(">models<");
  });
  it("15 dilde app.breadcrumb.models dolu", () => {
    const files = readdirSync(dir).filter((x) => x.endsWith(".json"));
    expect(files).toHaveLength(15);
    for (const f of files) expect(load(f.replace(".json", "")).app.breadcrumb.models).toMatch(/\S/);
  });
});
