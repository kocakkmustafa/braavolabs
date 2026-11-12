import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));

import ApprovalSheet from "../../components/approvals/ApprovalSheet";
import { showApprovalCenter, uxApprovalsEnabled } from "./flag";
import {
  canApprove, decisionNote, isDangerous, parseAmount, phraseMatches, readDetails, reversibleKey, textOrUnknown, toolName,
  type CenterApproval,
} from "./approval";

const t = (key: string, v?: Record<string, string | number>) => (key === "app.approvalCenter.danger.phrase" ? "Gönderimi onaylıyorum" : v ? `${key}${JSON.stringify(v)}` : key);
const base = (over: Partial<CenterApproval> = {}): CenterApproval => ({
  id: "a1", description: "Slack'e mesaj gönder", amountUsd: null, metadata: { toolName: "slack.post" },
  details: { risk: "low", permissions: ["slack.post:POST"], dataTransfer: ["POST → bağlantı x"], reversible: true }, ...over,
});
const sheet = (a: CenterApproval) => renderToStaticMarkup(
  <ApprovalSheet approval={a} t={t} legacyT={t as any} locale="tr" usd={(n) => `$${n}`} when="12 Kas 2026" busy={false} error={null} onDecide={() => {}} onClose={() => {}} />,
);

describe("bayrak", () => {
  it("varsayılan kapalı; yalnız 1/true açar (boşluk ve büyük harf duyarsız)", () => {
    expect(uxApprovalsEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes", "on"]) expect(uxApprovalsEnabled({ NEXT_PUBLIC_UX_APPROVALS: v })).toBe(false);
    for (const v of ["1", "true", " TRUE "]) expect(uxApprovalsEnabled({ NEXT_PUBLIC_UX_APPROVALS: v })).toBe(true);
  });
  it("?view=classic bayrak açıkken de eski sayfayı verir", () => {
    expect(showApprovalCenter(true, undefined)).toBe(true);
    expect(showApprovalCenter(true, "classic")).toBe(false);
    expect(showApprovalCenter(true, ["classic"])).toBe(false);
    expect(showApprovalCenter(false, undefined)).toBe(false);
  });
});

describe("tehlikeli karar tablosu", () => {
  const cases: Array<[string, Partial<CenterApproval>, boolean]> = [
    ["tutar 0 + düşük + geri alınabilir", { amountUsd: 0, details: { risk: "low", reversible: true } }, false],
    ["tutar > 0", { amountUsd: 0.01 }, true],
    ["tutar null, risk yok, geri alma yok (eski onay)", { amountUsd: null, details: null }, false],
    ["yüksek risk", { details: { risk: "high", reversible: true } }, true],
    ["orta risk", { details: { risk: "medium", reversible: true } }, false],
    ["geri alınamaz", { details: { risk: "low", reversible: false } }, true],
    ["geri alma bilinmiyor (null) tek başına tehlikeli değil", { details: { risk: "low", reversible: null } }, false],
    ["bozuk risk değeri yok sayılır", { details: { risk: "HIGH" as any } }, false],
    ["metin tutar \"12.50\" (Prisma Decimal) tehlikeli", { amountUsd: "12.50", details: null }, true],
    ["metin tutar \"0.00\" / \"0\" tehlikeli değil", { amountUsd: "0.00", details: null }, false],
    ["metin tutar \"abc\" / negatif tehlikeli değil", { amountUsd: "abc", details: null }, false],
  ];
  for (const [name, over, want] of cases) it(name, () => expect(isDangerous(base({ amountUsd: null, details: null, ...over }))).toBe(want));
});

describe("parseAmount", () => {
  it("sayı ve sayıya çevrilebilen metin kabul; diğerleri null", () => {
    expect(parseAmount(12.5)).toBe(12.5);
    expect(parseAmount(0)).toBe(0);
    expect(parseAmount("12.50")).toBe(12.5);
    expect(parseAmount(" 3 ")).toBe(3);
    expect(parseAmount("0.00")).toBe(0);
    for (const v of ["abc", "", "  ", "Infinity", "-1", NaN, Infinity, -0.5, null, undefined, {}, [], true]) expect(parseAmount(v)).toBeNull();
  });
  it("sheet: metin tutar gösterilir (Bilgi yok DEĞİL) ve tehlikeli kilit çıkar", () => {
    const html = sheet(base({ amountUsd: "12.50" }));
    expect(html).toContain("$12.5");
    expect(html).toContain('data-testid="approval-confirm-input"');
  });
});

describe("onay cümlesi", () => {
  it("Unicode NFC: ayrışık (NFD) ve birleşik (NFC) yazım aynı sayılır", () => {
    const nfd = "Go\u0308nderimi onaylıyorum"; // o + birleşen çift nokta
    const nfc = "Gönderimi onaylıyorum".normalize("NFC");
    expect(nfd).not.toBe(nfc);
    expect(phraseMatches(nfd, nfc, "tr")).toBe(true);
    expect(phraseMatches(nfc, nfd, "tr")).toBe(true);
  });
  const phrase = "Gönderimi onaylıyorum";
  it("büyük/küçük harf ve baştaki/sondaki boşluk duyarsız", () => {
    for (const s of ["gönderimi onaylıyorum", "  GÖNDERİMİ ONAYLIYORUM\n", "Gönderimi   onaylıyorum"]) expect(phraseMatches(s, phrase, "tr")).toBe(true);
  });
  it("eksik/fazla/boş eşleşmez; boş cümle asla eşleşmez", () => {
    for (const s of ["", "gönderimi", "gönderimi onaylıyorum.", "onaylıyorum"]) expect(phraseMatches(s, phrase, "tr")).toBe(false);
    expect(phraseMatches("", "", "tr")).toBe(false);
  });
  it("canApprove: tehlikesizde her zaman, tehlikelide yalnız eşleşince", () => {
    expect(canApprove(false, "", phrase)).toBe(true);
    expect(canApprove(true, "", phrase)).toBe(false);
    expect(canApprove(true, "GÖNDERİMİ onaylıyorum", phrase, "tr")).toBe(true);
  });
});

describe("Bilgi yok üretimi (uydurma yok)", () => {
  it("details yok/bozuk → tüm alanlar null", () => {
    for (const d of [undefined, null, {}, { risk: 5, permissions: "x", dataTransfer: [], reversible: "true" }] as any[])
      expect(readDetails({ details: d })).toEqual({ risk: null, permissions: null, dataTransfer: null, reversible: null });
  });
  it("dolu details aynen okunur; boş dizi ve boş metin elenir", () => {
    expect(readDetails({ details: { risk: "medium", permissions: ["a", " ", 3 as any], dataTransfer: ["b"], reversible: false } }))
      .toEqual({ risk: "medium", permissions: ["a"], dataTransfer: ["b"], reversible: false });
  });
  it("textOrUnknown ve toolName", () => {
    expect(textOrUnknown(null)).toEqual({ unknown: true });
    expect(textOrUnknown("  ")).toEqual({ unknown: true });
    expect(textOrUnknown(["a", "b"])).toEqual({ text: "a, b" });
    expect(toolName({ metadata: {} })).toBeNull();
    expect(toolName({ metadata: null })).toBeNull();
    expect(toolName({ metadata: { toolName: " slack.post " } })).toBe("slack.post");
  });
  it("geri alma etiketi: true/false/null", () => {
    expect(reversibleKey(true)).toBe("reversibleYes");
    expect(reversibleKey(false)).toBe("reversibleNo");
    expect(reversibleKey(null)).toBe("unknown");
  });
  it("decide notu: boş sebep not göndermez", () => {
    expect(decisionNote("   ")).toBeUndefined();
    expect(decisionNote(" sebep ")).toBe("sebep");
  });
});

describe("ApprovalSheet işaretlemesi", () => {
  it("dialog + aria-modal; §5.4 alanlarının hepsi; düşük riskte ikinci adım yok, Onayla açık", () => {
    const html = sheet(base());
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    for (const k of ["what", "tool", "permissions", "data", "risk", "amount", "reversible", "draft"]) expect(html).toContain(`app.approvalCenter.field.${k}`);
    expect(html).toContain("slack.post:POST");
    expect(html).toContain("app.approvalCenter.riskLevel.low");
    expect(html).toContain("app.approvalCenter.reversibleYes");
    expect(html).not.toContain('data-testid="approval-danger"');
    expect(html).toMatch(/data-testid="approval-approve"(?![^>]*disabled)/);
  });
  it("eski onayda kaynak alanlar 'Bilgi yok'; risk/geri alma etiketi uydurulmaz", () => {
    const html = sheet(base({ metadata: {}, details: null }));
    expect((html.match(/app\.approvalCenter\.unknown/g) ?? []).length).toBe(7); // araç, yetki, veri, risk, tutar, geri alma, taslak
    expect(html).not.toContain("riskLevel.");
    expect(html).not.toContain("reversibleYes");
    expect(html).not.toContain("reversibleNo");
  });
  it("tehlikeli onayda cümle alanı + sebep var; Onayla cümle olmadan devre dışı, Reddet açık", () => {
    for (const a of [base({ amountUsd: 12.5 }), base({ details: { risk: "high", reversible: true } }), base({ details: { risk: "low", reversible: false } })]) {
      const html = sheet(a);
      expect(html).toContain('data-testid="approval-confirm-input"');
      expect(html).toContain('data-testid="approval-reason"');
      expect(html).toContain("app.approvalCenter.danger.phraseLabel");
      expect(html).toMatch(/data-testid="approval-approve"[^>]*disabled/);
      expect(html).not.toMatch(/data-testid="approval-reject"[^>]*disabled/);
    }
  });
  it("geri alınamaz etiketi tehlikeli sheet'te görünür; toplu onay işareti yok", () => {
    const html = sheet(base({ details: { risk: "low", reversible: false } }));
    expect(html).toContain("app.approvalCenter.reversibleNo");
    expect(html).not.toMatch(/hepsini|toplu|approve-all|bulk/i);
  });
});
