import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { reducer, initialState, viewOf, entriesOf, type Action, type PageState } from "./integrationsPage";
import { settingsTabFromSearch } from "./settingsTab";
import { CatalogBody, ProviderCard, type T } from "../components/integrations/CatalogParts";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));
const t: T = (key) => key;
const run = (actions: Action[], from: PageState = initialState) => actions.reduce(reducer, from);
const P = [{ provider: "SLACK", name: "Slack", description: "Msgs", docsUrl: "https://api.slack.com" }];
const C = [{ id: "c1", name: "A" }, { id: "c2", name: "B" }];
const body = (s: PageState, search = "") => renderToStaticMarkup(
  <CatalogBody view={viewOf(s)} entries={entriesOf(s)} search={search} statusFailed={s.statusFailed} connectedCount={0} t={t} onRetry={() => {}} />,
);

describe("integrations page state", () => {
  it("başlangıç yükleniyor; providers hatası loadError + yeniden dene", () => {
    expect(viewOf(initialState)).toBe("loading");
    const s = run([{ type: "providersFailed" }]);
    expect(viewOf(s)).toBe("providersError");
    const html = body(s);
    expect(html).toContain("app.integrations.loadError");
    expect(html).toContain('role="alert"');
    expect(html).toContain("app.integrations.retry");
  });
  it("şirket listesi hatası: ErrorBox + yeniden dene", () => {
    const s = run([{ type: "providers", providers: P }, { type: "companiesFailed" }]);
    expect(viewOf(s)).toBe("companiesError");
    expect(body(s)).toContain("app.integrations.companiesLoadError");
  });
  it("şirketsiz hesap: açık mesaj, kart ve Bağla yok, durum için şirket seçilmez", () => {
    const s = run([{ type: "providers", providers: P }, { type: "companies", companies: [] }]);
    expect(viewOf(s)).toBe("noCompany");
    expect(s.companyId).toBe("");
    const html = body(s);
    expect(html).toContain("app.integrations.noCompany");
    expect(html).not.toContain("app.integrations.connect");
  });
  it("boş sağlayıcı listesi emptyProviders", () => {
    const s = run([{ type: "providers", providers: [] }, { type: "companies", companies: C }]);
    expect(viewOf(s)).toBe("empty");
    expect(body(s)).toContain("app.integrations.emptyProviders");
  });
  it("durum hatası: 'alınamadı' uyarısı + kartlar unknown", () => {
    const s = run([{ type: "providers", providers: P }, { type: "companies", companies: C }, { type: "statusFailed", companyId: "c1" }]);
    expect(viewOf(s)).toBe("ready");
    expect(entriesOf(s)[0].state).toBe("unknown");
    const html = body(s);
    expect(html).toContain("app.integrations.statusLoadError");
    expect(html).toContain("app.integrations.statusUnknown");
  });
  it("şirket değişince eski şirketin yanıtı yok sayılır", () => {
    let s = run([{ type: "providers", providers: P }, { type: "companies", companies: C }]);
    expect(s.companyId).toBe("c1");
    s = run([{ type: "selectCompany", companyId: "c2" }], s);
    expect(s.integrations).toBeNull();
    s = run([{ type: "status", companyId: "c1", rows: [{ provider: "SLACK", status: "ACTIVE" }] }], s);
    expect(s.integrations).toBeNull();
    s = run([{ type: "statusFailed", companyId: "c1" }], s);
    expect(s.statusFailed).toBe(false);
    s = run([{ type: "status", companyId: "c2", rows: [{ provider: "SLACK", status: "EXPIRED" }] }], s);
    expect(entriesOf(s)[0].state).toBe("expired");
  });
  it("docs bağlantısı target=_blank rel=noopener noreferrer; Bağla/Yönet ?tab=integrations", () => {
    const [e] = entriesOf(run([{ type: "providers", providers: P }, { type: "companies", companies: C }, { type: "status", companyId: "c1", rows: [] }]));
    const html = renderToStaticMarkup(<ul><ProviderCard entry={e} t={t} /></ul>);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="/settings?tab=integrations"');
  });
  it("EXPIRED kartı uyarı simgesi + Yönet", () => {
    const [e] = entriesOf(run([{ type: "providers", providers: P }, { type: "companies", companies: C }, { type: "status", companyId: "c1", rows: [{ provider: "SLACK", status: "EXPIRED" }] }]));
    const html = renderToStaticMarkup(<ul><ProviderCard entry={e} t={t} /></ul>);
    expect(html).toContain("app.integrations.statusExpired");
    expect(html).toContain("app.integrations.manage");
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("settings sekme derin bağlantısı", () => {
  const ids = ["profile", "integrations", "billing"];
  it("beyaz liste; geçersiz/eksik profile düşer", () => {
    expect(settingsTabFromSearch("?tab=integrations", ids)).toBe("integrations");
    expect(settingsTabFromSearch("?tab=evil", ids)).toBe("profile");
    expect(settingsTabFromSearch("", ids)).toBe("profile");
  });
});
