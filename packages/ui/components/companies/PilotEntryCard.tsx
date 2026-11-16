"use client";
/**
 * BRA-P1-07-N3 — Şirket sayfasında "Pilot" giriş kartı. Bayrak (NEXT_PUBLIC_UX_PILOT) kapalıyken hiçbir şey çizmez.
 * Mikro-uygulama paketi (pilot): bu şirketin yapılandırması + sentetik örnek veri; mevcut micro-app ucu çağrılır, JSON indirilir.
 * Gönderim/yazma yetkisini paket değil bağlayıcı kapsamı sınırlar; kart bunu zorlama olarak sunmaz.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { uxPilotEnabled } from "../../lib/pilot-entry/flag";
import { downloadJsonFile, shouldFocusResult, triggerPilotExport, type PilotExportState } from "../../lib/pilot-entry/export";

const card: React.CSSProperties = {
  display: "grid", gap: 12, padding: 16, borderRadius: 14, background: "var(--color-surface-container)", color: "var(--color-on-surface)",
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-surface-container-high)",
};
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13, margin: 0 };

export default function PilotEntryCard({ companyId, enabled, initialState }: {
  companyId: string;
  /** Test/önizleme: bayrağı geçersiz kılar. */
  enabled?: boolean;
  initialState?: PilotExportState;
}) {
  const on = enabled ?? uxPilotEnabled({ NEXT_PUBLIC_UX_PILOT: process.env.NEXT_PUBLIC_UX_PILOT });
  const { token, hydrated } = useAuthGuard();
  const t = useTranslations();
  const pt = (k: string, v?: Record<string, string | number>) => t(`app.pilotEntry.${k}`, v);
  const [state, setState] = useState<PilotExportState>(initialState ?? { status: "idle" });
  const lock = useRef(false);
  const cancelled = useRef(false);
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { cancelled.current = false; return () => { cancelled.current = true; }; }, []);
  // Sonuç/hata görününce odak sonuç bölgesine taşınır (klavye ve ekran okuyucu için).
  useEffect(() => { if (shouldFocusResult(state.status)) resultRef.current?.focus(); }, [state.status]);

  if (!on) return null;
  const busy = state.status === "loading";
  const onExport = () => {
    triggerPilotExport({
      hydrated, token, companyId, busy, fetchPackage: () => api.exportMicroApp(token as string, companyId),
      download: downloadJsonFile, setState, lock, isCancelled: () => cancelled.current,
    });
  };
  const preview = state.status === "done" ? state.preview : null;

  return (
    <section aria-labelledby="pilot-entry-h" data-testid="pilot-entry-card" className="mb-6" style={card} aria-busy={busy}>
      <h2 id="pilot-entry-h" className="bv-title" style={{ margin: 0 }}>{pt("title")}</h2>
      <div style={{ display: "grid", gap: 4 }}>
        <p style={muted}>{pt("description")}</p>
        <ul style={{ ...muted, paddingInlineStart: 18, margin: 0 }} data-testid="pilot-entry-notes">
          <li>{pt("syntheticOnly")}</li>
          <li>{pt("connectorsNote")}</li>
        </ul>
      </div>
      <div>
        <button type="button" className="bv-btn bv-btn-primary bv-btn-sm" data-testid="pilot-entry-export"
          aria-disabled={busy || !hydrated || !token} onClick={onExport}>
          {busy ? pt("exporting") : pt("export")}
        </button>
      </div>
      <div role="status" aria-live="polite" data-testid="pilot-entry-status" style={muted}>
        {busy && pt("exporting")}
        {state.status === "done" && pt("exported")}
      </div>
      {state.status === "error" && (
        <div role="alert" ref={resultRef} tabIndex={-1} data-testid="pilot-entry-error" data-kind={state.kind}>{pt(`error.${state.kind}`)}</div>
      )}
      <div ref={state.status === "done" ? resultRef : undefined} tabIndex={state.status === "done" ? -1 : undefined}
        aria-labelledby="pilot-entry-preview-h" data-testid="pilot-entry-preview">
        <h3 id="pilot-entry-preview-h" style={{ margin: "0 0 6px", fontSize: 14 }}>{pt("previewTitle")}</h3>
        {preview === null ? (
          <p style={muted} data-testid="pilot-entry-nodata">{pt("noData")}</p>
        ) : (
          <dl style={{ margin: 0, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
            <div><dt style={muted}>{pt("previewName")}</dt><dd style={{ margin: 0 }} data-testid="pilot-preview-name"><bdi>{preview.name}</bdi></dd></div>
            <div><dt style={muted}>{pt("previewAgents")}</dt><dd style={{ margin: 0 }} data-testid="pilot-preview-agents">{preview.agents}</dd></div>
            <div><dt style={muted}>{pt("previewPipelines")}</dt><dd style={{ margin: 0 }} data-testid="pilot-preview-pipelines">{preview.pipelines}</dd></div>
            <div><dt style={muted}>{pt("previewRecords")}</dt><dd style={{ margin: 0 }} data-testid="pilot-preview-records">{preview.records}</dd></div>
            <div><dt style={muted}>{pt("previewConnectors")}</dt>
              <dd style={{ margin: 0 }} data-testid="pilot-preview-connectors">
                {preview.connectors.length === 0 ? pt("noConnectors") : preview.connectors.map((c) => <bdi key={c} className="bv-pill bv-pill-muted" style={{ marginInlineEnd: 4 }}>{c}</bdi>)}
                {preview.connectorsHidden > 0 && <span>{pt("moreConnectors", { count: preview.connectorsHidden })}</span>}
              </dd></div>
          </dl>
        )}
      </div>
    </section>
  );
}
