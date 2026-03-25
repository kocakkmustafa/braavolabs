"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAppStore } from "../lib/store";

const PUBLIC_PATHS = ["/login", "/auth", "/landing"];
const LANDING_PATH = "/";

export default function AuthLayout({ children, sidebar }: { children: React.ReactNode; sidebar: React.ReactNode }) {
  const token = useAppStore((s) => s.token);
  const [hydrated, setHydrated] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setHydrated(true);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Before hydration, render without sidebar to avoid mismatch
  // (zustand persist restores token from localStorage only on client)
  if (!hydrated) {
    return (
      <div className="flex h-screen">
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    );
  }

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p)) || pathname === LANDING_PATH;
  const showSidebar = !!token && !isPublicPage;

  return (
    <div className="flex h-screen">
      {showSidebar && sidebar}

      {/* Mobile sidebar overlay */}
      {showSidebar && mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          {/* Sidebar panel */}
          <div className="fixed inset-y-0 left-0 w-[260px] z-50 flex flex-col gradient-dark text-white border-r border-white/5">
            <div className="flex items-center justify-end px-3 py-3">
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="Close menu"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {sidebar}
          </div>
        </div>
      )}

      <main className="flex-1 overflow-auto">
        {/* Hamburger button — mobile only */}
        {showSidebar && (
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="lg:hidden fixed top-4 left-4 z-40 p-2 rounded-lg bg-white/[0.08] border border-white/[0.12] text-slate-300 hover:bg-white/[0.12] transition-colors"
            aria-label="Open menu"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
        )}
        {children}
      </main>
    </div>
  );
}
