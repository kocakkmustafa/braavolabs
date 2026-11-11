/** BRA-UX-05a — Niyet Çubuğu ekranı ortak stilleri. Renk/marka mevcut token'lardan gelir (yeni renk yok). */
import type { CSSProperties } from "react";

export const glass: CSSProperties = {
  background: "var(--bv-glass-bg, var(--color-surface-container))", border: "1px solid var(--bv-glass-border, var(--color-outline-variant))",
  backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderRadius: 16, padding: 16,
};
export const flat: CSSProperties = { background: "var(--color-surface-container)", border: "1px solid var(--color-outline-variant)", borderRadius: 12, padding: 12 };
export const muted: CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };
export const btn: CSSProperties = {
  minHeight: 44, padding: "8px 16px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-outline-variant)",
};
export const btnPrimary: CSSProperties = { ...btn, background: "var(--color-primary)", color: "var(--color-on-primary)", border: "1px solid transparent" };
