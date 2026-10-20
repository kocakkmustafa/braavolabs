"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useAppStore } from "../lib/store";
import { sounds } from "../lib/sounds";

// labelKey → nav.* i18n key (localized at render). Labels were hardcoded EN;
// now resolved per-locale.
const NAV_ITEMS = [
  { href: "/", labelKey: "nav.home", icon: "home", publicOnly: true },
  { href: "/dashboard", labelKey: "nav.commandCenter", icon: "dashboard", authOnly: true },
  { href: "/companies", labelKey: "nav.workspaces", icon: "business", authOnly: true },
  { href: "/pipelines", labelKey: "nav.workflows", icon: "account_tree", authOnly: true },
  { href: "/approvals", labelKey: "nav.approvals", icon: "task_alt", authOnly: true },
  { href: "/drafts", labelKey: "nav.drafts", icon: "edit_note", authOnly: true },
  { href: "/analytics", labelKey: "nav.analytics", icon: "query_stats", authOnly: true },
  { href: "/risks", labelKey: "nav.risks", icon: "security", authOnly: true },
  { href: "/integrations", labelKey: "nav.integrations", icon: "hub", authOnly: true },
  { href: "/connections", labelKey: "nav.connections", icon: "lan", authOnly: true },
  { href: "/ab-tests", labelKey: "nav.abTests", icon: "science", authOnly: true },
  { href: "/webhooks", labelKey: "nav.webhooks", icon: "webhook", authOnly: true },
  { href: "/billing", labelKey: "nav.billing", icon: "credit_card", authOnly: true },
  { href: "/settings", labelKey: "nav.settings", icon: "settings", authOnly: true },
];

const PUBLIC_ITEMS = [
  { href: "/features", labelKey: "nav.features", icon: "auto_awesome" },
  { href: "/pricing", labelKey: "nav.pricing", icon: "sell" },
];

export default function Sidebar({ drawer = false }: { drawer?: boolean }) {
  const uiText = useLegacyTranslations("uiCopy");
  const [interactiveExpanded, setExpanded] = useState(false);
  const expanded = drawer || interactiveExpanded;
  const [progress, setProgress] = useState<number | null>(null);
  const pathname = usePathname();
  const token = useAppStore((s) => s.token);
  const t = useTranslations();

  useEffect(() => {
    if (!token) return;
    import("../lib/api").then(({ api }) => {
      api.onboardingStatus(token).then((s) => setProgress(s.progress)).catch(() => {});
    });
  }, [token]);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const visibleItems = token
    ? NAV_ITEMS.filter((i) => !i.publicOnly)
    : [...NAV_ITEMS.filter((i) => !i.authOnly), ...PUBLIC_ITEMS];

  const W = expanded ? 220 : 56;

  return (
    <aside
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocusCapture={() => setExpanded(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExpanded(false); }}
      style={{
        position: "fixed", insetInlineStart: 0, top: 0, height: "100dvh", width: drawer ? "min(260px, calc(100vw - 64px))" : W,
        background: "var(--color-surface)",
        borderInlineEnd: "1px solid var(--color-outline-variant)",
        zIndex: 60, display: "flex", flexDirection: "column",
        transition: "width 0.28s cubic-bezier(0.4,0,0.2,1)",
        overflow: "hidden",
        boxShadow: expanded ? "4px 0 32px rgba(0,0,0,0.5)" : "none",
      }}
    >
      {/* Logo */}
      <div style={{ padding: "20px 0", display: "flex", alignItems: "center", justifyContent: "center", height: 64, flexShrink: 0 }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", paddingInlineStart: expanded ? 16 : 0, transition: "padding 0.28s", width: "100%", justifyContent: expanded ? "flex-start" : "center" }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 16px rgba(0,209,255,0.2)",
            transition: "box-shadow 0.3s",
          }}>
            <span style={{ color: "white", fontWeight: 700, fontSize: 11 }}>AI</span>
          </div>
          {expanded && (
            <span style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 700, fontSize: 13, letterSpacing: "-0.02em",
              background: "linear-gradient(135deg, #a4e6ff, #e0b6ff)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              whiteSpace: "nowrap", overflow: "hidden",
              animation: "fade-in 0.3s ease-out",
            }}>
              BRAAVOLABS
            </span>
          )}
        </Link>
      </div>

      {/* Nav items */}
      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "4px 6px" }}>
        {visibleItems.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={t(item.labelKey)}
              aria-current={active ? "page" : undefined}
              title={!expanded ? t(item.labelKey) : undefined}
              onClick={() => sounds.click()}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px", borderRadius: 10, marginBottom: 2,
                textDecoration: "none",
                justifyContent: expanded ? "flex-start" : "center",
                background: active ? "rgba(0,209,255,0.08)" : "transparent",
                color: active ? "var(--color-primary)" : "var(--color-on-surface-variant)",
                transition: "all 0.2s cubic-bezier(0.4,0,0.2,1)",
                borderInlineStart: active ? "2px solid var(--color-primary)" : "2px solid transparent",
                whiteSpace: "nowrap",
                position: "relative",
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                  e.currentTarget.style.color = "var(--color-on-surface)";
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "rgba(230,227,251,0.45)";
                }
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20, flexShrink: 0 }}>{item.icon}</span>
              {expanded && <span style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", opacity: expanded ? 1 : 0, transition: "opacity 0.2s 0.1s" }}>{t(item.labelKey)}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Onboarding progress */}
      {token && progress !== null && progress < 100 && (
        <div style={{ padding: "8px 10px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: expanded ? "space-between" : "center", marginBottom: 4 }}>
            {expanded && <span style={{ fontSize: 10, color: "var(--color-on-surface-variant)", letterSpacing: "0.08em" }}>{uiText("ma770817c8ec3")}</span>}
            {expanded && <span style={{ fontSize: 10, color: "var(--color-primary)", fontWeight: 600 }}>{progress}%</span>}
          </div>
          <div style={{ height: 3, borderRadius: 999, background: "rgba(255,255,255,0.04)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, #00d1ff, #6d11ad)", transition: "width 0.8s cubic-bezier(0.16,1,0.3,1)", borderRadius: 999 }} />
          </div>
        </div>
      )}

      {/* Bottom actions */}
      <div style={{ padding: "8px 6px", borderTop: "1px solid rgba(255,255,255,0.04)", flexShrink: 0 }}>
        {token ? (
          <>
            <Link
              href="/onboarding"
              onClick={() => sounds.build()}
              style={{
                display: "flex", alignItems: "center", justifyContent: expanded ? "flex-start" : "center",
                gap: 8, padding: "10px", borderRadius: 10, marginBottom: 4,
                background: "linear-gradient(135deg, rgba(0,209,255,0.1), rgba(109,17,173,0.1))",
                border: "1px solid rgba(0,209,255,0.15)",
                color: "var(--color-primary)", textDecoration: "none", fontSize: 13, fontWeight: 600,
                whiteSpace: "nowrap",
                transition: "all 0.25s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(0,209,255,0.3)"; e.currentTarget.style.boxShadow = "0 0 20px rgba(0,209,255,0.1)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(0,209,255,0.15)"; e.currentTarget.style.boxShadow = "none"; }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18, flexShrink: 0 }}>add</span>
              {expanded && t("nav.newWorkspace")}
            </Link>
            <Link
              href="/onboarding"
              style={{
                display: "flex", alignItems: "center", justifyContent: expanded ? "flex-start" : "center",
                gap: 8, padding: "8px 10px", borderRadius: 10,
                color: "rgba(230,227,251,0.3)", textDecoration: "none", fontSize: 12,
                whiteSpace: "nowrap", transition: "color 0.2s",
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = "rgba(230,227,251,0.6)"}
              onMouseLeave={(e) => e.currentTarget.style.color = "rgba(230,227,251,0.3)"}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16, flexShrink: 0 }}>rocket_launch</span>
              {expanded && t("nav.quickStart")}
            </Link>
          </>
        ) : (
          <Link
            href="/login"
            onClick={() => sounds.click()}
            className="btn-primary"
            style={{
              justifyContent: expanded ? "flex-start" : "center",
              width: "100%", padding: "10px", borderRadius: 10,
              textDecoration: "none", fontSize: 13, whiteSpace: "nowrap",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18, flexShrink: 0 }}>login</span>
            {expanded && t("nav.signIn")}
          </Link>
        )}
      </div>
    </aside>
  );
}
