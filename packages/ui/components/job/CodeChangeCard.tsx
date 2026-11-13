/**
 * BRA-UX-05e — "Kod değişikliğini incele" kartı (tasarım §5.12), Çıktı sekmesinde makbuzun altında; yalnız `NEXT_PUBLIC_UX_CODE` açıkken.
 * YALNIZ OKUR: Kabul et / Reddet düğmesi yok (kararı yazacak uç yok; API-06 salt-okur). Koşu onay bekliyorsa onay merkezine bağlantı verilir.
 * Bilinmeyen sayı "Bilinmiyor" yazar (0 uydurulmaz); `complete:false` ise toplam "en az"; liste kırpıldıysa "+K dosya daha".
 * Durum yalnız renkle anlatılmaz (metin + simge). Animasyon yok (hareket azaltma tercihinde de değişen bir şey olmaz).
 */
import Link from "next/link";
import type { CodeView, CodeTestsView } from "../../lib/ux-code/summary";
import { hasCodeChange } from "../../lib/ux-code/summary";
import type { T } from "../inbox/InboxParts";

export type CodeState = { status: "loading" } | { status: "error" } | { status: "ready"; view: CodeView };

const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };
const srOnly: React.CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
const btn: React.CSSProperties = {
  minHeight: 44, padding: "6px 14px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "var(--color-surface-container-high)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-highest)",
};

/** Satır sayısı; bilinmiyorsa "Bilinmiyor" (sayı uydurulmaz). */
const fmt = (n: number | null, locale: string, sign: string, t: T): string => {
  if (n === null) return t("app.codeChange.unknown");
  let s: string;
  try { s = n.toLocaleString(locale); } catch { s = String(n); }
  return `${sign}${s}`;
};
const num = (n: number, locale: string): string => { try { return n.toLocaleString(locale); } catch { return String(n); } };

export function testsParts(x: CodeTestsView, t: T, locale: string): string[] {
  const parts: string[] = [];
  parts.push(x.passed === null ? t("app.codeChange.testsPassedUnknown") : t("app.codeChange.testsPassed", { count: num(x.passed, locale) }));
  parts.push(x.failed === null ? t("app.codeChange.testsFailedUnknown") : t("app.codeChange.testsFailed", { count: num(x.failed, locale) }));
  if (x.skipped === null) parts.push(t("app.codeChange.testsSkippedUnknown"));
  else if (x.skipped > 0) parts.push(t("app.codeChange.testsSkipped", { count: num(x.skipped, locale) }));
  if (x.passed === null && x.failed === null && x.total !== null) parts.push(t("app.codeChange.testsTotal", { count: num(x.total, locale) }));
  return parts;
}

export default function CodeChangeCard({ state, title, awaitingApproval, t, locale, rtl, onRetry }: {
  state: CodeState | null; title: string; awaitingApproval: boolean; t: T; locale: string; rtl: boolean; onRetry: () => void;
}) {
  if (state === null) return null;
  const heading = t("app.codeChange.title", { title });
  let body: React.ReactNode;
  let live = "";
  if (state.status === "loading") body = <p style={muted}>{t("app.codeChange.loading")}</p>;
  else if (state.status === "error") {
    body = (
      <div style={{ display: "grid", gap: 8, justifyItems: "start" }}>
        <p role="alert" style={{ ...muted, color: "var(--color-error)" }}>{t("app.codeChange.error")}</p>
        <button type="button" style={btn} onClick={onRetry}>{t("app.codeChange.retry")}</button>
      </div>
    );
  } else if (!hasCodeChange(state.view)) body = <p style={muted} data-testid="code-none">{t("app.codeChange.none")}</p>;
  else {
    const { diff, tests } = state.view;
    const tp = tests ? testsParts(tests, t, locale) : null;
    const testsText = tp ? tp.join(" · ") : t("app.codeChange.unknown");
    const filesText = diff
      ? [t("app.codeChange.filesTitle", { count: num(diff.fileCount, locale) }), `${fmt(diff.additions, locale, "+", t)} ${fmt(diff.deletions, locale, "−", t)}`].join(", ")
      : t("app.codeChange.filesUnknown");
    live = t("app.codeChange.srSummary", { title: heading, files: filesText, tests: tp ? tp.join(", ") : testsText });
    const rest = diff ? Math.max(0, diff.fileCount - diff.files.length) : 0;
    body = (
      <div style={{ display: "grid", gap: 10 }}>
        {diff ? (
          <details open data-testid="code-files">
            <summary style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", fontWeight: 700 }}>{t("app.codeChange.filesTitle", { count: num(diff.fileCount, locale) })}</summary>
            {diff.files.length === 0 ? <p style={muted}>{t("app.codeChange.filesNone")}</p> : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                {diff.files.map((f, i) => (
                  <li key={`${f.path}-${i}`} data-testid="code-file" style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "baseline", fontSize: 13 }}>
                    <code dir="ltr" style={{ unicodeBidi: "isolate", overflowWrap: "anywhere", minWidth: 0 }}>{f.path}</code>
                    <span style={{ whiteSpace: "nowrap" }}>
                      <span style={{ color: f.additions === null ? undefined : "var(--color-primary)" }}>{fmt(f.additions, locale, "+", t)}</span>{" "}
                      <span style={{ color: f.deletions === null ? undefined : "var(--color-error)" }}>{fmt(f.deletions, locale, "−", t)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {rest > 0 && <p style={muted} data-testid="code-more">{t("app.codeChange.moreFiles", { count: rest })}</p>}
            <p style={{ margin: "6px 0 0", fontSize: 13 }} data-testid="code-totals">
              {t(diff.complete ? "app.codeChange.totals" : "app.codeChange.totalsAtLeast", { added: fmt(diff.additions, locale, "+", t), removed: fmt(diff.deletions, locale, "−", t) })}
            </p>
            {!diff.complete && <p style={muted} data-testid="code-partial">{t("app.codeChange.partialNote")}</p>}
          </details>
        ) : <p style={{ margin: 0 }} data-testid="code-files-unknown"><strong>{t("app.codeChange.filesUnknown")}</strong></p>}
        <div data-testid="code-tests" style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", alignItems: "baseline" }}>
          <strong>{t("app.codeChange.testsTitle")}:</strong>
          <span>{testsText}</span>
          {tests && (tests.ok
            ? <span data-testid="code-tests-ok">{`✓ ${t("app.codeChange.testsVerified")}`}</span>
            : <span data-testid="code-tests-unverified" style={{ fontWeight: 700 }}>{`! ${t("app.codeChange.testsNotVerified")}`}</span>)}
          {tests && tests.runs !== null && tests.runs > 1 && <span style={muted} data-testid="code-tests-runs">{t("app.codeChange.testsRuns", { count: tests.runs })}</span>}
        </div>
      </div>
    );
  }
  return (
    <section data-testid="code-change" aria-label={heading} dir={rtl ? "rtl" : undefined}
      style={{ marginTop: 10, padding: 12, borderRadius: 10, background: "var(--color-surface-container-low)", display: "grid", gap: 8, minWidth: 0 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, overflowWrap: "anywhere" }}>{heading}</h3>
      <span role="status" aria-live="polite" data-testid="code-live" style={srOnly}>{live}</span>
      {body}
      {awaitingApproval && state.status === "ready" && (
        <Link href="/approvals" data-testid="code-approvals-link" style={{ minHeight: 44, display: "inline-flex", alignItems: "center", textDecoration: "underline", color: "var(--color-primary)", fontSize: 14 }}>{t("app.codeChange.approvalLink")}</Link>
      )}
    </section>
  );
}
