"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "../components/Sidebar";
import CommandPalette from "../components/CommandPalette";
import NotificationBell from "../components/NotificationBell";
import OnboardingChecklist from "../components/OnboardingChecklist";
import Breadcrumb from "../components/Breadcrumb";
import PresenceBar from "../components/PresenceBar";

// Landing page renders its own nav — skip sidebar offset.
// "/" is the cinematic full-bleed stage (promoted from the `/forge-home`
// prototype on 2026-07-26, along with the retired `/forge`); it must not be
// squeezed by the dashboard sidebar/breadcrumb chrome.
const FULL_WIDTH_PATHS = ["/", "/login", "/register", "/reset-password", "/features", "/pricing", "/terms", "/privacy", "/auth/callback"];

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => { setHydrated(true); }, []);
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  if (!hydrated) {
    return <div className="min-h-screen" style={{ background: "#0a0d14" }}><main>{children}</main></div>;
  }

  const isFullWidth = FULL_WIDTH_PATHS.includes(pathname);

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      {/* Desktop sidebar — hidden on landing page */}
      {!isFullWidth && (
        <div className="hidden lg:block">
          <Sidebar />
        </div>
      )}

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fixed inset-0"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
            onClick={() => setMobileOpen(false)}
          />
          <div
            className="fixed inset-y-0 left-0 z-50"
            style={{ width: 260, transition: "transform 0.25s ease" }}
          >
            <Sidebar />
          </div>
        </div>
      )}

      {/* Global overlays */}
      <CommandPalette />
      {!isFullWidth && <PresenceBar />}
      {!isFullWidth && <NotificationBell />}
      {!isFullWidth && <OnboardingChecklist />}

      {/* Main content */}
      <main
        className={`min-h-screen ${!isFullWidth ? "lg:ml-14" : ""}`}
        style={{ background: "#0a0d14" }}
      >
        {/* Mobile hamburger — hidden on landing page */}
        {!isFullWidth && (
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden fixed top-4 left-4 z-40 p-2.5 rounded-xl"
            style={{
              background: "rgba(16,19,26,0.9)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#bbc9cf",
              backdropFilter: "blur(12px)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}
            aria-label="Open menu"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
        )}
        <div className={!isFullWidth ? "pt-14 lg:pt-0" : ""}>
          {!isFullWidth && <Breadcrumb />}
          {children}
        </div>
      </main>
    </div>
  );
}
