"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useAppStore } from "../lib/store";
import { api } from "../lib/api";
import { formatCurrency, formatNumber } from "../i18n/locales";

type Approval = { id: string; description?: string; action?: string; amountUsd?: number | string | null };
export default function NotificationBell() {
  const t = useTranslations("app.notifications");
  const copy = useTranslations("surface");
  const locale = useLocale();
  const token = useAppStore(s => s.token);
  const revision = useAppStore(s => s.sessionRevision);
  const tenantId = useAppStore(s => s.tenantId);
  const scope = useMemo(() => ({ revision, tenantId, locale }), [revision, tenantId, locale]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [loaded, setLoaded] = useState<{ scope: typeof scope; items: Approval[] | null; failed: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();
  const data = loaded?.scope === scope ? loaded : null;
  const count = data?.items?.length ?? null;

  useEffect(() => {
    let active = true;
    setOpen(false);
    if (!token) return;
    function ownsScope() {
      const auth = useAppStore.getState();
      return active && currentScope.current === scope && auth.sessionRevision === revision && auth.tenantId === tenantId;
    }
    async function refresh() {
      try {
        const items = await api.listApprovals(token!, "PENDING");
        if (!Array.isArray(items)) throw Error("Invalid approval response");
        if (ownsScope()) setLoaded({ scope, items, failed: false });
      } catch {
        if (ownsScope()) setLoaded(previous => ({ scope, items: previous?.scope === scope ? previous.items : null, failed: true }));
      }
    }
    void refresh();
    const interval = setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(interval); };
  }, [token, scope, revision, tenantId]);

  useEffect(() => { if (open) closeButton.current?.focus(); }, [open]);
  function dismiss() { setOpen(false); button.current?.focus(); }
  if (!token) return null;

  return (
    <div style={{ position: "fixed", top: 16, insetInlineEnd: 20, zIndex: 100 }} onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); dismiss(); } }}>
      <button ref={button} type="button" onClick={() => setOpen(value => !value)}
        aria-label={t("title")} aria-expanded={open} aria-controls={open ? panelId : undefined}
        style={{ width: 44, height: 44, borderRadius: 10, background: "var(--color-surface)", border: "1px solid var(--color-outline)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-on-surface)", position: "relative" }}>
        <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 18 }}>notifications</span>
        {count !== null && count > 0 && <span aria-hidden="true" className="bv-pill bv-pill-red" style={{ position: "absolute", top: -5, insetInlineEnd: -5, fontSize: 10 }}>{count > 9 ? `${formatNumber(9, locale)}+` : formatNumber(count, locale)}</span>}
      </button>
      {open && <>
        <div style={{ position: "fixed", inset: 0 }} onClick={dismiss} aria-hidden="true" />
        <section id={panelId} aria-labelledby={titleId} style={{ position: "absolute", top: 52, insetInlineEnd: 0, width: "min(300px, calc(100vw - 40px))", maxHeight: "calc(100dvh - 88px)", overflowY: "auto", borderRadius: 14, background: "var(--color-surface)", border: "1px solid var(--color-outline)", boxShadow: "0 8px 32px rgba(0,0,0,0.25)", zIndex: 101 }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-outline-variant)", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <h2 id={titleId} style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("title")}</h2>
            <button ref={closeButton} type="button" aria-label={copy("close")} onClick={dismiss} className="bv-btn bv-btn-ghost" style={{ width: 44, height: 44, padding: 0 }}><span aria-hidden="true" className="material-symbols-outlined">close</span></button>
          </div>
          <p role="status" style={{ padding: "12px 16px", margin: 0, color: "var(--color-on-surface-variant)", fontSize: 12 }}>
            {data?.failed ? copy("loadFailed") : count === null ? copy("loading") : count === 0 ? t("clear") : t("pending", { count })}
          </p>
          {data?.items?.slice(0, 5).map(item => <a key={item.id} href="/approvals" style={{ display: "block", padding: "12px 16px", borderTop: "1px solid var(--color-outline-variant)", color: "var(--color-on-surface)", textDecoration: "none", overflowWrap: "anywhere" }}>
            <p style={{ fontSize: 12, fontWeight: 600, margin: "0 0 4px" }}>{t("spend")}</p>
            <p style={{ fontSize: 12, margin: 0, color: "var(--color-on-surface-variant)" }}>{item.description ?? item.action}</p>
            {item.amountUsd != null && item.amountUsd !== "" && <p style={{ fontSize: 12, margin: "4px 0 0" }}>{formatCurrency(item.amountUsd, "USD", locale)}</p>}
          </a>)}
          <div style={{ padding: 12 }}><a href="/approvals" className="bv-btn bv-btn-ghost" style={{ display: "flex", justifyContent: "center" }}>{t("viewAll")}</a></div>
        </section>
      </>}
    </div>
  );
}
