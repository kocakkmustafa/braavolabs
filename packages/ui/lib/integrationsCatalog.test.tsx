import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { buildCatalog, filterCatalog, countByState, connectionState, type ProviderInfo } from "./integrationsCatalog";
import { ProviderCard, RequestCard, ErrorBox, type T } from "../components/integrations/CatalogParts";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));
const t: T = (key) => key;

const providers: ProviderInfo[] = [
  { provider: "SLACK", name: "Slack", description: "Post messages", docsUrl: "https://api.slack.com", fields: [{ key: "token", label: "Token" }] },
  { provider: "HUBSPOT", name: "HubSpot", description: "CRM", docsUrl: "javascript:alert(1)", fields: [] },
  { provider: "NOTION", name: "Notion", description: "Docs and wikis" },
];

describe("integrations catalog data flow", () => {
  it("katalog yalnız API sağlayıcılarından kurulur; durum API satırından gelir", () => {
    const c = buildCatalog(providers, [
      { provider: "SLACK", status: "ACTIVE", lastTestedAt: "2026-11-01T00:00:00Z" },
      { provider: "HUBSPOT", status: "ERROR" },
    ]);
    expect(c.map((e) => e.provider)).toEqual(["HUBSPOT", "NOTION", "SLACK"]);
    expect(Object.fromEntries(c.map((e) => [e.provider, e.state]))).toEqual({ HUBSPOT: "error", NOTION: "none", SLACK: "connected" });
    expect(c.find((e) => e.provider === "SLACK")!.fieldCount).toBe(1);
  });
  it("durum alınamazsa (null) 'unknown'; 'bağlı değil' tahmin edilmez", () => {
    expect(buildCatalog(providers, null).every((e) => e.state === "unknown")).toBe(true);
  });
  it("https olmayan docsUrl düşer; bilinmeyen durum 'none'", () => {
    const c = buildCatalog(providers, []);
    expect(c.find((e) => e.provider === "HUBSPOT")!.docsUrl).toBeNull();
    expect(c.find((e) => e.provider === "SLACK")!.docsUrl).toBe("https://api.slack.com");
    expect(connectionState("PENDING")).toBe("pending");
    expect(connectionState(undefined)).toBe("none");
  });
  it("boş sağlayıcı listesi boş katalog; arama ve sayaç", () => {
    expect(buildCatalog([], [])).toEqual([]);
    const c = buildCatalog(providers, [{ provider: "SLACK", status: "ACTIVE" }]);
    expect(filterCatalog(c, " wiki ").map((e) => e.provider)).toEqual(["NOTION"]);
    expect(filterCatalog(c, "")).toHaveLength(3);
    expect(countByState(c)).toMatchObject({ connected: 1, none: 2, error: 0 });
  });
});

describe("integrations markup", () => {
  const [slack, hub] = [buildCatalog(providers, [{ provider: "SLACK", status: "ACTIVE" }, { provider: "HUBSPOT", status: "ERROR" }])[2], buildCatalog(providers, [{ provider: "HUBSPOT", status: "ERROR" }])[0]];
  it("kart durum etiketi, 44px hedef ve adlandırılmış bağlantılar taşır", () => {
    const html = renderToStaticMarkup(<ul><ProviderCard entry={slack} t={t} /></ul>);
    expect(html).toContain("app.integrations.statusConnected");
    expect(html).toContain("app.integrations.manage");
    expect(html).toContain('aria-label="app.integrations.docs: Slack"');
    expect(html).toContain("min-height:44px");
    expect(html).not.toMatch(/green|border/);
  });
  it("hata durumu kırmızı pill; bağlı olmayan 'connect'", () => {
    expect(renderToStaticMarkup(<ul><ProviderCard entry={hub} t={t} /></ul>)).toContain("bv-pill-red");
    const none = buildCatalog(providers, [])[1];
    expect(renderToStaticMarkup(<ul><ProviderCard entry={none} t={t} /></ul>)).toContain("app.integrations.connect");
  });
  it("Talep et mevcut /contact yoluna gider; hata kutusu role=alert + yeniden dene", () => {
    expect(renderToStaticMarkup(<RequestCard t={t} />)).toContain('href="/contact"');
    const e = renderToStaticMarkup(<ErrorBox t={t} body="B" onRetry={() => {}} />);
    expect(e).toContain('role="alert"');
    expect(e).toContain("app.integrations.retry");
  });
});
