"use client";

import { useTranslations } from "next-intl";

const SERVICES = [
  { nm: "API",                sub: "api.braavolabs.com",     up: "99.99%", st: "ok"  },
  { nm: "Run engine (SSE)",   sub: "streaming runs",          up: "99.97%", st: "ok"  },
  { nm: "Visual builder",     sub: "pipeline canvas",         up: "100.0%", st: "ok"  },
  { nm: "Connections poller", sub: "n8n · Make · Zapier",     up: "99.82%", st: "deg" },
  { nm: "Webhooks fan-in",    sub: "/hooks/:slug",            up: "99.95%", st: "ok"  },
  { nm: "Mobile push",        sub: "deep-links",              up: "99.91%", st: "ok"  },
] as const;

const INCIDENTS = [
  {
    title: "Connections poller — elevated latency",
    meta: "Make polling delayed up to 90s · monitoring",
    badge: "deg" as const,
    bv: "bv-pill-amber",
    label: "Degraded",
    date: "Jun 2, 14:20 UTC",
  },
  {
    title: "API — brief 502s during deploy",
    meta: "Resolved in 4m · rolling deploy fixed",
    badge: "resolved" as const,
    bv: "bv-pill-cyan",
    label: "Resolved",
    date: "May 29, 03:11 UTC",
  },
  {
    title: "Run engine — SSE reconnect storm",
    meta: "Resolved in 12m · backpressure added",
    badge: "resolved" as const,
    bv: "bv-pill-cyan",
    label: "Resolved",
    date: "May 18, 19:40 UTC",
  },
] as const;

type ServiceStatus = "ok" | "deg" | "down";

function UptimeBars({ st }: { st: ServiceStatus }) {
  const bars: { cls: string; h: number }[] = Array.from({ length: 40 }, (_, i) => {
    const r = (Math.sin(i * 7.3 + (st === "deg" ? 2.1 : 0)) + 1) / 2;
    let cls = "";
    if (st === "deg" && i > 32 && r > 0.5) cls = "deg";
    if (st === "down" && i > 35) cls = "down";
    const h = cls ? 60 + r * 40 : 78 + r * 22;
    return { cls, h };
  });

  return (
    <div className="flex gap-px items-end h-7 flex-1">
      {bars.map((b, i) => (
        <span
          key={i}
          className="flex-1 rounded-[1px]"
          style={{
            height: `${b.h}%`,
            background:
              b.cls === "down"
                ? "var(--bv-status-failed)"
                : b.cls === "deg"
                ? "var(--bv-status-running)"
                : "var(--bv-status-completed)",
            opacity: 0.85,
          }}
        />
      ))}
    </div>
  );
}

function ServiceDot({ st }: { st: ServiceStatus }) {
  if (st === "ok")
    return <span className="bv-dot bv-completed bv-ping" style={{ background: "var(--bv-status-completed)" }} />;
  if (st === "deg")
    return <span className="bv-dot bv-running bv-ping" />;
  return <span className="bv-dot bv-failed bv-ping" />;
}

const ST_LABEL: Record<ServiceStatus, string> = {
  ok: "Operational",
  deg: "Degraded",
  down: "Down",
};

const ST_COLOR: Record<ServiceStatus, string> = {
  ok:   "color-mix(in srgb, var(--bv-status-completed) 90%, transparent)",
  deg:  "color-mix(in srgb, var(--bv-status-running) 90%, transparent)",
  down: "color-mix(in srgb, var(--bv-status-failed) 90%, transparent)",
};

export default function StatusPage() {
  const t = useTranslations();
  const serviceKeys = ["website", "auth", "api", "runs", "database", "email"] as const;

  return (
    <div className="bv-mesh min-h-screen" style={{ fontFamily: "var(--bv-font-body)" }}>
      {/* ── Nav ───────────────────────────────────────── */}
      <nav
        className="flex items-center justify-between px-6 md:px-10 py-4 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid var(--bv-glass-border)" }}
      >
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <div className="bv-avatar" style={{ width: 32, height: 32, borderRadius: 10 }}>
            AI
          </div>
          <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
        </a>
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="bv-btn bv-btn-ghost bv-btn-sm flex items-center gap-1.5 no-underline"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>arrow_back</span>
            {t("static.common.back")}
          </a>
        </div>
      </nav>

      {/* ── Page head ─────────────────────────────────── */}
      <div className="max-w-[860px] mx-auto px-6 pt-14 pb-4">
        {/* eyebrow */}
        <p className="bv-micro mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>monitor_heart</span>
          System status
        </p>

        {/* Banner — All systems operational */}
        <div
          className="bv-glass flex items-center gap-4 px-6 py-5 mb-8"
          style={{ borderRadius: 16 }}
        >
          {/* big ping dot */}
          <span
            className="bv-dot bv-completed bv-ping"
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              background: "var(--bv-status-completed)",
              boxShadow: "0 0 16px var(--bv-status-completed)",
            }}
          />
          <div className="flex-1 min-w-0">
            <h1
              className="bv-headline"
              style={{ fontSize: "clamp(18px,3vw,28px)", textTransform: "uppercase", letterSpacing: "-0.01em" }}
            >
              {t("static.status.title")}
            </h1>
          </div>
          <div className="flex items-center gap-2 bv-mono" style={{ color: "var(--color-outline)", flexShrink: 0 }}>
            <span
              className="bv-dot bv-completed"
              style={{ background: "var(--bv-status-completed)", width: 7, height: 7 }}
            />
            <span>auto-refresh · 15s</span>
          </div>
        </div>

        {/* ── Services card ─────────────────────────────── */}
        <div className="bv-glass" style={{ borderRadius: 16, overflow: "hidden" }}>
          {SERVICES.map((svc, idx) => (
            <div
              key={svc.nm}
              className="flex items-center gap-4 px-5 py-4"
              style={{
                borderBottom: idx < SERVICES.length - 1 ? "1px solid var(--bv-glass-border)" : "none",
              }}
            >
              {/* name + sub */}
              <div style={{ minWidth: 160 }}>
                <div className="text-sm font-medium text-on-surface">{svc.nm}</div>
                <div className="bv-mono mt-0.5" style={{ color: "var(--color-outline)" }}>{svc.sub}</div>
              </div>

              {/* uptime spark bars */}
              <UptimeBars st={svc.st as ServiceStatus} />

              {/* uptime % */}
              <span className="bv-mono text-on-surface-variant" style={{ minWidth: 56, textAlign: "right" }}>
                {svc.up}
              </span>

              {/* status label */}
              <div
                className="flex items-center gap-2 bv-mono"
                style={{ minWidth: 110, justifyContent: "flex-end", color: ST_COLOR[svc.st as ServiceStatus] }}
              >
                <ServiceDot st={svc.st as ServiceStatus} />
                {ST_LABEL[svc.st as ServiceStatus]}
              </div>
            </div>
          ))}
        </div>

        {/* ── Incident history ──────────────────────────── */}
        <section className="mt-14 mb-20">
          <h2
            className="bv-headline mb-6"
            style={{ textTransform: "uppercase", letterSpacing: "-0.01em" }}
          >
            Incident history
          </h2>

          <div className="flex flex-col gap-0">
            {INCIDENTS.map((inc, idx) => (
              <div key={idx} className="grid gap-4" style={{ gridTemplateColumns: "30px 1fr", paddingBottom: 22 }}>
                {/* rail */}
                <div className="flex flex-col items-center">
                  <span
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: "50%",
                      marginTop: 5,
                      flexShrink: 0,
                      border: `2px solid ${inc.badge === "deg" ? "var(--bv-status-running)" : "var(--bv-status-completed)"}`,
                      boxShadow: `0 0 8px ${inc.badge === "deg" ? "var(--bv-status-running)" : "var(--bv-status-completed)"}`,
                      background: "var(--color-background)",
                      display: "block",
                    }}
                  />
                  {idx < INCIDENTS.length - 1 && (
                    <span
                      className="flex-1 mt-1"
                      style={{
                        width: 2,
                        background: "linear-gradient(180deg, var(--bv-steel-shadow), transparent)",
                      }}
                    />
                  )}
                </div>

                {/* content */}
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-on-surface">{inc.title}</span>
                    <span className={`bv-pill ${inc.bv}`}>{inc.label}</span>
                  </div>
                  <div className="bv-mono mt-1" style={{ color: "var(--color-outline)" }}>
                    {inc.meta} · {inc.date}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Alert box (from original page) ─────────────── */}
        <div
          className="bv-glass px-5 py-4 mb-16 text-sm"
          style={{
            borderRadius: 14,
            borderColor: "rgba(59,130,246,0.2)",
            color: "var(--color-on-surface-variant)",
          }}
        >
          <strong className="text-on-surface">{t("static.status.alertTitle")}</strong>{" "}
          {t("static.status.alertBody")}
        </div>
      </div>

      {/* ── Footer nav ────────────────────────────────── */}
      <footer
        className="border-t max-w-[1100px] mx-auto px-6 py-8"
        style={{ borderColor: "var(--bv-glass-border)" }}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div>
            <a href="/" className="flex items-center gap-2 mb-3 no-underline">
              <div className="bv-avatar" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 10 }}>AI</div>
              <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
            </a>
            <p className="bv-caption" style={{ color: "var(--color-outline)" }}>
              Command the AI agents &amp; automations you already run.
            </p>
          </div>
          <div>
            <h5 className="bv-micro mb-3">Product</h5>
            <div className="flex flex-col gap-2">
              {["Features", "Pricing", "Changelog"].map((l) => (
                <a key={l} href={`/${l.toLowerCase()}`} className="bv-caption text-on-surface-variant hover:text-on-surface transition-colors no-underline">{l}</a>
              ))}
            </div>
          </div>
          <div>
            <h5 className="bv-micro mb-3">Company</h5>
            <div className="flex flex-col gap-2">
              {["About", "Blog", "Contact"].map((l) => (
                <a key={l} href={`/${l.toLowerCase()}`} className="bv-caption text-on-surface-variant hover:text-on-surface transition-colors no-underline">{l}</a>
              ))}
            </div>
          </div>
          <div>
            <h5 className="bv-micro mb-3">Legal</h5>
            <div className="flex flex-col gap-2">
              {["Privacy", "Terms", "KVKK"].map((l) => (
                <a key={l} href={`/${l.toLowerCase()}`} className="bv-caption text-on-surface-variant hover:text-on-surface transition-colors no-underline">{l}</a>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
