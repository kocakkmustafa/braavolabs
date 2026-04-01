"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAppStore } from "../lib/store";

const ROUTE_LABELS: Record<string, string> = {
  "": "Home",
  dashboard: "Dashboard",
  companies: "Companies",
  new: "New Company",
  pipelines: "Pipelines",
  approvals: "Approvals",
  drafts: "Drafts",
  analytics: "Analytics",
  risks: "Risk Shield",
  settings: "Settings",
  billing: "Billing",
  marketplace: "Marketplace",
  onboarding: "Onboarding",
  runs: "Runs",
};

// Simple cache for company name lookups
const nameCache: Record<string, string> = {};

export default function Breadcrumb() {
  const pathname = usePathname();
  const token = useAppStore((s) => s.token);
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({});

  // Compute segments before early return — hooks must be called unconditionally
  const segments = pathname.split("/").filter(Boolean);

  // Check if any segment looks like an ID (long hash) and try to resolve it
  useEffect(() => {
    if (!token || segments.length < 2) return;

    segments.forEach((seg, i) => {
      // Skip known route labels
      if (ROUTE_LABELS[seg]) return;
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
      ?? ROUTE_LABELS[seg]
      ?? (seg.length > 12 ? `${seg.slice(0, 8)}...` : seg);
    const isLast = i === segments.length - 1;
    return { href, label, isLast };
  });

  return (
    <nav className="flex items-center gap-1.5 px-4 sm:px-6 pt-4 pb-0 text-xs" aria-label="Breadcrumb">
      <Link href="/" className="flex items-center" style={{ color: "#3c494e", textDecoration: "none" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>home</span>
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          <span style={{ color: "#3c494e" }}>/</span>
          {crumb.isLast ? (
            <span style={{ color: "#859399", fontWeight: 500 }}>{crumb.label}</span>
          ) : (
            <Link
              href={crumb.href}
              style={{ color: "#3c494e", textDecoration: "none" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#00d1ff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#3c494e"; }}
            >
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
