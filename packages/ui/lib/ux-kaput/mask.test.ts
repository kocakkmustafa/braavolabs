import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { maskKaputText, clipText, safeText, MASK } from "./mask";

describe("maskKaputText", () => {
  it("Bearer belirteci", () => {
    expect(maskKaputText("Authorization: Bearer abc123DEF456ghi789")).toBe(`Authorization: ${MASK}`);
  });
  it("sk-/ghp_/xoxb- anahtarları", () => {
    expect(maskKaputText("key sk-proj-ABCDEF1234567890 bitti")).toBe(`key ${MASK} bitti`);
    expect(maskKaputText(`ghp_${"A1".repeat(12)}`)).toBe(MASK);
    expect(maskKaputText("xoxb-1234-5678-abcdefgh")).toBe(MASK);
  });
  it("JWT", () => {
    expect(maskKaputText("t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF_123-xyz ok")).toBe(`t=${MASK} ok`);
  });
  it("URL sorgu dizesi ve kullanıcı:parola@", () => {
    expect(maskKaputText("GET https://api.x.com/v1/items?token=abc&id=5 failed")).toBe(`GET https://api.x.com/v1/items?${MASK} failed`);
    expect(maskKaputText("postgres://admin:hunter2@db.internal:5432/app")).toBe(`postgres://${MASK}@db.internal:5432/app`);
  });
  it("Slack webhook yolu", () => {
    expect(maskKaputText("POST https://hooks.slack.com/services/T000/B000/XXXXXXXX failed")).toBe(`POST https://hooks.slack.com/${MASK} failed`);
  });
  it("uzun hex ve base64 dizileri", () => {
    expect(maskKaputText(`id ${"a1b2c3d4".repeat(4)} x`)).toBe(`id ${MASK} x`);
    expect(maskKaputText(`blob ${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldY".repeat(2)}== son`)).toBe(`blob ${MASK} son`);
  });
  it("kimlik bilgisinde '@' içeren parola son '@'e kadar gizlenir", () => {
    expect(maskKaputText("postgres://user:p@ss@db.internal:5432/app")).toBe(`postgres://${MASK}@db.internal:5432/app`);
    expect(maskKaputText("see https://example.com/a@b/c ok")).toBe("see https://example.com/a@b/c ok");
  });
  it("token benzeri: 40 karakterlik harf+rakam karışımı ve ≥40 harfli koşu gizlenir; 32+ yalnız harf gizlenmez", () => {
    expect(maskKaputText("t " + "aB3dE5gH7jK9".repeat(4).slice(0, 40) + " son")).toBe(`t ${MASK} son`);
    expect(maskKaputText("t " + "a".repeat(45))).toBe(`t ${MASK}`);
    expect(maskKaputText("x " + "uzunluk".repeat(5))).toBe("x " + "uzunluk".repeat(5)); // 35 harf, rakam yok
  });
  it("yanlış pozitif yok: UUID, kebab/snake ad, noktasız yol", () => {
    for (const s of [
      "run 3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d failed",
      "very-long-descriptive-step-name-ok",
      "very_long_descriptive_step_name_ok_but_snake",
      "/api/v1/companies/abc/pipelines/xyz/runs",
    ]) expect(maskKaputText(s)).toBe(s);
  });
  it("yanlış pozitif yok: normal cümle, kısa kimlik, tarih, kısa sorgusuz URL", () => {
    for (const s of [
      "Bağlantı sıfırlandı, tekrar denenecek.",
      "run r1 step s-2 failed (code 403)",
      "2026-11-12T09:00:00.000Z tarihinde başladı",
      "see https://docs.example.com/guide for help",
      "ID: 4f2a9c (kısa)",
      "sk-ip bu adımı atla",
    ]) expect(maskKaputText(s)).toBe(s);
  });
  it("clipText vekil çiftini bölmez; safeText önce maskeler sonra kırpar", () => {
    expect(clipText("😀😀😀", 2)).toBe("😀😀…");
    const input = "ab Bearer Zk3Zk3Zk3Zk3Zk3";
    expect(maskKaputText(clipText(input, 14))).toContain("Zk3"); // yanlış sıra (önce kırp) sızdırır: ayırt edici
    const out = safeText(input, 14);
    expect(out).toBe(`ab ${MASK}`);
    expect(out).not.toContain("Zk3");
  });
});

describe("i18n: app.jobs.kaput.* yer tutucu eşitliği (15 dil)", () => {
  const dir = join(__dirname, "..", "..", "messages");
  const langs = ["ar", "de", "en", "es-419", "es", "fr", "hi", "id", "it", "ja", "ko", "pl", "pt-BR", "tr", "zh-Hans"];
  const flat = (o: Record<string, unknown>, pre = ""): Record<string, string> =>
    Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === "string" ? { ...a, [pre + k]: v } : { ...a, ...flat(v as Record<string, unknown>, `${pre}${k}.`) }), {});
  const load = (l: string) => flat(JSON.parse(readFileSync(join(dir, `${l}.json`), "utf8")).app.jobs.kaput);
  const ph = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(",");
  const en = load("en");
  it("anahtar kümesi ve {yer tutucu}lar tüm dillerde en ile aynı", () => {
    expect(Object.keys(en).length).toBeGreaterThan(25);
    for (const l of langs) {
      const m = load(l);
      expect(Object.keys(m).sort(), l).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en)) { expect(ph(m[key]), `${l}:${key}`).toBe(ph(en[key])); expect(m[key].trim(), `${l}:${key}`).not.toBe(""); }
    }
  });
});
