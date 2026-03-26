"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

export default function Breadcrumb() {
  const pathname = usePathname();

  // Don't show on root or simple routes
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const crumbs = segments.map((seg, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    const label = ROUTE_LABELS[seg] ?? (seg.length > 12 ? `${seg.slice(0, 8)}...` : seg);
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
