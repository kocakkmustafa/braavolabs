import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
const doc = readFileSync(
  fileURLToPath(new URL("../../../docs/tasarim-token-eslesme.tr.md", import.meta.url)),
  "utf8",
);

const lightStart = css.indexOf("html.light {");
const dark = css.slice(0, lightStart);
const light = css.slice(lightStart, css.indexOf("}", lightStart));

function tok(block: string, name: string): string {
  const m = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token yok: ${name}`);
  return m[1];
}

function lum(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const ROLES = ["primary", "success", "warning", "error"] as const;

describe.each([
  ["koyu", dark],
  ["açık", light],
] as const)("web %s palet", (_n, block) => {
  it.each(ROLES)("%s metin kontrastı >= 4.5", (role) => {
    expect(ratio(tok(block, role), tok(block, "background"))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(ROLES)("%s değeri eşleme tablosunda ilgili satırın web sütununda yazılı", (role) => {
    const label = role === "error" ? "danger" : role;
    const row = doc.split("\n").find((l) => l.startsWith(`| ${label} |`));
    if (!row) throw new Error(`tablo satırı yok: ${label}`);
    const webCell = row.split("|")[2].toLowerCase();
    expect(webCell).toContain(tok(block, role).toLowerCase());
  });
});
