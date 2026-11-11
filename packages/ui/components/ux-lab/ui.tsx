"use client";
/** BRA-UX-04 — prototip ortak stil ve küçük bileşenler. Renk/marka mevcut token'lardan gelir (yeni renk yok). */
import type { CSSProperties, ReactNode } from "react";

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
export const btnDanger: CSSProperties = { ...btn, color: "var(--color-error)" };

/** Mod rozeti: örnek veri asla gerçekmiş gibi görünmez. */
export function ModeBadge({ mode }: { mode: "sample" | "live" }) {
  return (
    <span data-testid="uxl-mode" data-mode={mode} style={{ ...muted, border: "1px solid var(--color-outline-variant)", borderRadius: 999, padding: "2px 10px", fontWeight: 700 }}>
      {mode === "sample" ? "ÖRNEK VERİ" : "CANLI VERİ"}
    </span>
  );
}

/** Kaynak alan yok: uydurma yok, "bilgi yok" yazılır (§5.4). */
export const Missing = () => <span style={{ ...muted, fontStyle: "italic" }}>bilgi yok</span>;
export const NeedsApi = ({ what }: { what: string }) => <span style={{ ...muted, fontStyle: "italic" }}>{what}: API ister</span>;

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 15, letterSpacing: 0.2 }}>{title}</h2>{aside}
      </div>
      {children}
    </section>
  );
}

export function Alert({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" style={{ ...flat, display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", borderColor: "var(--color-error)" }}>
      <span>{children}</span>{onRetry && <button type="button" style={btn} onClick={onRetry}>Yeniden dene</button>}
    </div>
  );
}

/** Duyarlı düzen ve sabit mobil alt çubuk (§5.9). Animasyon yok: reduced-motion kendiliğinden uyumlu. */
export const LAB_CSS = `
.uxl-root{max-width:960px;margin:0 auto;padding:16px 16px 96px;display:grid;gap:16px}
.uxl-nav{display:flex;gap:8px;flex-wrap:wrap}
.uxl-nav button{min-height:44px;padding:8px 16px;border-radius:10px;border:1px solid var(--color-outline-variant);background:transparent;color:var(--color-on-surface);font-weight:600;cursor:pointer}
.uxl-nav button[aria-current="page"]{background:var(--color-primary);color:var(--color-on-primary);border-color:transparent}
.uxl-row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.uxl-row button.uxl-link{background:none;border:0;color:inherit;text-align:start;cursor:pointer;min-height:44px;font:inherit;padding:0}
.uxl-drawer{position:fixed;z-index:60;inset-inline:0;bottom:0;max-height:78vh;overflow:auto;border-radius:16px 16px 0 0}
.uxl-sheet{position:fixed;z-index:70;inset-inline:0;bottom:0;max-height:88vh;overflow:auto;border-radius:16px 16px 0 0}
@media (max-width:767px){
  .uxl-nav{position:fixed;z-index:50;inset-inline:0;bottom:0;padding:8px 12px;background:var(--bv-glass-bg,var(--color-surface-container));border-top:1px solid var(--color-outline-variant);backdrop-filter:blur(12px);justify-content:space-between;flex-wrap:nowrap}
  .uxl-nav button{flex:1;padding:8px 4px;font-size:13px}
}
@media (min-width:768px){
  .uxl-drawer,.uxl-sheet{inset-inline-start:auto;inset-inline-end:16px;bottom:16px;width:440px;max-height:calc(100vh - 32px);border-radius:16px}
}
`;
