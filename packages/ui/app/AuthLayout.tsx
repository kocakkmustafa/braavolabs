"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "../components/Sidebar";
import CommandPalette from "../components/CommandPalette";
import NotificationBell from "../components/NotificationBell";

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
    return <div className="min-h-screen" style={{ background: "#10131a" }}><main>{children}</main></div>;
  }

  return (
    <div className="min-h-screen" style={{ background: "#10131a" }}>
      {/* Desktop sidebar — always visible */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fixed inset-0"
            style={{ background: "rgba(0,0,0,0.6)" }}
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50" style={{ width: 220 }}>
            <Sidebar />
          </div>
        </div>
      )}

      {/* Global overlays */}
      <CommandPalette />
      <NotificationBell />

      {/* Main content — always offset by 56px on desktop */}
      <main className="lg:ml-14 min-h-screen" style={{ background: "#10131a" }}>
        {/* Mobile hamburger */}
        <button
          onClick={() => setMobileOpen(true)}
          className="lg:hidden fixed top-4 left-4 z-40 p-2 rounded-lg"
          style={{ background: "rgba(29,32,38,0.8)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}
          aria-label="Open menu"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <div className="pt-14 lg:pt-0">
          {children}
        </div>
      </main>
    </div>
  );
}
