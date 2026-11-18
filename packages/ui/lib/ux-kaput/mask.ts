/**
 * BRA-UX-05d — Kaput serbest metinleri (hata, gerekçe, ad) ekrana basılmadan ÖNCE istemci tarafında maskelenir.
 * Saf; yanlış-pozitifi düşük tutar (normal cümle, kısa kimlik, tarih bozulmaz). Sunucu tarafı maskeleme yerine geçmez.
 */
export const MASK = "[gizlendi]";

const RULES: Array<[RegExp, string]> = [
  // Authorization başlığı
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, MASK],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  // sağlayıcı anahtarları
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, MASK],
  // Slack webhook yolu
  [/hooks\.slack\.com\/services\/[^\s"'<>]*/gi, `hooks.slack.com/${MASK}`],
  // kullanıcı:parola@
  // açgözlü: parolada '@' olsa bile son '@'e kadar (yetki bölümü '/' ile biter)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]*@/gi, `$1${MASK}@`],
  // URL sorgu dizesi
  [/(\bhttps?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, `$1?${MASK}`],
  // uzun hex
  [/\b[A-Fa-f0-9]{32,}\b/g, MASK],
];

/**
 * Token benzeri dizi: sınırlayıcı olarak yalnız harf/rakam/+ ile kurulu koşu (`-`, `/`, `_` YOK: UUID, kebab/snake ad, yol bozulmaz).
 * Gizlenir: (a) ≥32 uzunlukta VE hem harf hem rakam içeren, ya da (b) ≥40 uzunlukta herhangi bir koşu.
 * Lookbehind yok (Safari <16.4): önceki karakter yakalama grubuyla geri konur.
 */
const TOKENISH = /(^|[^A-Za-z0-9+/=-])([A-Za-z0-9+]{32,}={0,2})(?![A-Za-z0-9+/=-])/g;
const isTokenish = (run: string) => {
  const core = run.replace(/=+$/, "");
  return core.length >= 40 || (/[A-Za-z]/.test(core) && /\d/.test(core));
};

export function maskKaputText(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.replace(TOKENISH, (m, pre: string, run: string) => (isTokenish(run) ? `${pre}${MASK}` : m));
}

/** Vekil çiftini bölmeden (kod noktası sayısıyla) kırpar. */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : chars.join("");
}

/** Maskele, sonra kırp (sıra önemli: kesilen anahtar parçası sızmasın). */
export function safeText(text: string, max: number): string {
  return clipText(maskKaputText(text), max);
}
