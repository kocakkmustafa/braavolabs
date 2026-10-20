"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useAppStore } from "../lib/store";

// slug → i18n key (resolved per-locale at render). Reuses nav.* where labels
// match; breadcrumb-only labels live under app.breadcrumb.
const ROUTE_LABEL_KEYS: Record<string, string> = {
  "": "nav.home",
  dashboard: "nav.dashboard",
  companies: "nav.workspaces",
  new: "nav.newWorkspace",
  pipelines: "nav.workflows",
  approvals: "nav.approvals",
  drafts: "nav.drafts",
  analytics: "nav.analytics",
  risks: "nav.risks",
  settings: "nav.settings",
  billing: "nav.billing",
  onboarding: "app.breadcrumb.onboarding",
  runs: "app.breadcrumb.runs",
};

// Simple cache for company name lookups
const nameCache: Record<string, string> = {};

export default function Breadcrumb() {
  const uiText = useLegacyTranslations("uiCopy");
  const pathname = usePathname();
  const t = useTranslations();
  const token = useAppStore((s) => s.token);
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({});

  // Compute segments before early return — hooks must be called unconditionally
  const segments = pathname.split("/").filter(Boolean);

  // Check if any segment looks like an ID (long hash) and try to resolve it
  useEffect(() => {
    if (!token || segments.length < 2) return;

    segments.forEach((seg, i) => {
      // Skip known route labels
      if (ROUTE_LABEL_KEYS[seg]) return;
      // If it looks like an ID (>12 chars, has letters and numbers)
      if (seg.length > 12 && /[a-z]/.test(seg) && /[0-9]/.test(seg)) {
        // Check if the previous segment is "companies"
        if (i > 0 && segments[i - 1] === "companies") {
          if (nameCache[seg]) {
            setResolvedNames((prev) => ({ ...prev, [seg]: nameCache[seg] }));
          } else {
            import("../lib/api").then(({ api }) => {
              api.getCompany(token, seg).then((c: any) => {
                const name = c?.name ?? seg;
                nameCache[seg] = name;
                setResolvedNames((prev) => ({ ...prev, [seg]: name }));
              }).catch(() => {});
            });
          }
        }
      }
    });
  }, [pathname, token]);

  // Don't show on root or simple routes
  if (segments.length < 2) return null;

  const crumbs = segments.map((seg, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    // Priority: resolved name > route label > truncated segment
    const label = resolvedNames[seg]
      ?? (ROUTE_LABEL_KEYS[seg] ? t(ROUTE_LABEL_KEYS[seg]) : undefined)
      ?? (seg.length > 12 ? `${seg.slice(0, 8)}...` : seg);
    const isLast = i === segments.length - 1;
    return { href, label, isLast };
  });

  return (
    <nav className="flex items-center gap-1.5 px-4 sm:px-6 pt-4 pb-0 text-xs" aria-label={uiText("me0038ce40084")}>
      <Link href="/" className="flex items-center" style={{ color: "var(--color-on-surface-variant)", textDecoration: "none" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>home</span>
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          <span style={{ color: "var(--color-on-surface-variant)" }}>/</span>
          {crumb.isLast ? (
            <span style={{ color: "var(--color-on-surface-variant)", fontWeight: 500 }}>{crumb.label}</span>
          ) : (
            <Link
              href={crumb.href}
              style={{ color: "var(--color-on-surface-variant)", textDecoration: "none" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#00d1ff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-on-surface-variant)"; }}
            >
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
