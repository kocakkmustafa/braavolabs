/**
 * Compliance kapısı — içerik kuyruğa GİRMEDEN önce durdurulur.
 *
 * Bu kapı yayın hedefinden bağımsızdır: caption'ı doğrular, nereye gideceğini
 * bilmez. Mimari değişse de (Slack-drop → doğrudan API) aynı kalması bu
 * yüzden mümkün oldu.
 *
 * Kurallar Mac tarafındaki `config/compliance.yml` + `brands.yml` ile
 * hizalıdır. Burada TS sabiti olarak tutulur ki motor Mac'teki dosyalara
 * bağımlı olmasın — kaynak değişirse `holding/bin/regen-registry.sh`
 * benzeri bir tazeleme adımıyla senkronlanır.
 */

import type { SocialBrand } from "./types";

export interface ComplianceResult {
  ok: boolean;
  issues: string[];
  /** Otomatik düzeltilmiş caption (örn. Burun Farkı footer'ı eklenmiş). */
  fixedCaption?: string;
}

/**
 * Burun Farkı 18+ zorunlulukları — TJK analiz ürünü, bahis teşviki DEĞİL.
 * Yeşilay footer'ı her gönderide bulunmak zorunda.
 */
const BURUNFARKI_FORBIDDEN = [
  "garantili",
  "kesin",
  "100%",
  "yüzde yüz",
  "kesin tutar",
  "kazandır",
];

const BURUNFARKI_FOOTER = "18+ · Yeşilay 182 · yesilay.org.tr";

/** Tüm markalarda yasak — engagement-bait ve platform politikası ihlalleri. */
const GLOBAL_BANNED = [
  "takip et kazan",
  "etiketle kazan",
  "yorum yap kazan",
  "follow to win",
  "tag to win",
];

const BRAND_FORBIDDEN: Partial<Record<SocialBrand, string[]>> = {
  burunfarki: BURUNFARKI_FORBIDDEN,
};

const BRAND_FOOTER: Partial<Record<SocialBrand, string>> = {
  burunfarki: BURUNFARKI_FOOTER,
};

function wordPresent(haystack: string, needle: string): boolean {
  // Türkçe ekleri yakalamak için kelime sınırı yerine alt-dize araması
  // (Python tarafındaki \b davranışının pratikte gördüğü sonuç bu).
  return haystack.includes(needle.toLowerCase());
}

export function checkCaption(brand: SocialBrand, caption: string): ComplianceResult {
  const text = caption.toLowerCase();
  const issues: string[] = [];

  for (const word of BRAND_FORBIDDEN[brand] ?? []) {
    if (wordPresent(text, word)) issues.push(`forbidden_word:${word}`);
  }
  for (const phrase of GLOBAL_BANNED) {
    if (text.includes(phrase)) issues.push(`engagement_bait:${phrase}`);
  }

  if (issues.length) return { ok: false, issues };

  const footer = BRAND_FOOTER[brand];
  if (footer && !text.includes(footer.toLowerCase())) {
    return { ok: true, issues: [], fixedCaption: `${caption.trimEnd()}\n\n${footer}` };
  }
  return { ok: true, issues: [] };
}

/** Toplu doğrulama — hepsi temizse fixed map döner, biri bile kirliyse issues dolu. */
export function validateAll(
  brand: SocialBrand,
  captions: Record<string, string | undefined>,
): { issues: string[]; fixed: Record<string, string> } {
  const issues: string[] = [];
  const fixed: Record<string, string> = {};
  for (const [key, cap] of Object.entries(captions)) {
    if (!cap) continue;
    const res = checkCaption(brand, cap);
    if (!res.ok) {
      issues.push(...res.issues.map((i) => `${key}:${i}`));
      continue;
    }
    fixed[key] = res.fixedCaption ?? cap;
  }
  return { issues, fixed };
}
