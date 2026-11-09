"use client";
import { useEffect, useRef } from "react";

type T = (key: string) => string;

/** Yükleme hatası: role="alert" + «Yeniden dene». `inline` = liste korunurken üstte uyarı. */
export function ApprovalsLoadError({ t, inline, onRetry }: { t: T; inline?: boolean; onRetry: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Hata ilk göründüğünde odak uyarıya gider (ekran okuyucu + klavye).
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="mb-5 flex items-center gap-3 px-4 py-3 rounded-xl text-sm"
      style={{ background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.22)", color: "#FF8A8A", flexWrap: "wrap" }}
    >
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18, color: "#FF4D4D" }}>error</span>
      <div style={{ flex: "1 1 220px" }}>
        <p style={{ fontWeight: 700, margin: 0 }}>{t(inline ? "app.approvals.refreshErrorTitle" : "app.approvals.loadErrorTitle")}</p>
        <p style={{ margin: 0 }}>{t(inline ? "app.approvals.refreshErrorBody" : "app.approvals.loadErrorBody")}</p>
      </div>
      <button type="button" className="bv-btn bv-btn-primary bv-btn-sm" onClick={onRetry}>{t("app.approvals.retryLoad")}</button>
    </div>
  );
}

export function ApprovalsEmpty({ t }: { t: T }) {
  return (
    <div className="bv-glass rounded-2xl py-16 px-6 text-center bv-rise">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.18)" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 26, color: "var(--color-primary)" }}>check_circle</span>
      </div>
      <p className="bv-title mb-1">{t("app.approvals.emptyTitle")}</p>
      <p className="bv-caption">{t("app.approvals.emptyBody")}</p>
    </div>
  );
}

export function ApprovalsLoading({ t }: { t: T }) {
  return <div role="status" className="bv-caption text-center py-16">{t("app.approvals.loading")}</div>;
}
