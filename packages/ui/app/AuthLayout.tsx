"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
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
  const menuDialog = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const t = useTranslations("app.shell");

  useEffect(() => { setHydrated(true); }, []);
  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const dialog = menuDialog.current;
    if (!dialog) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    if (desktop.matches) { setMobileOpen(false); return; }
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    dialog.showModal();
    return () => {
      desktop.removeEventListener("change", closeOnDesktop);
      if (dialog.open) dialog.close();
      menuButton.current?.focus();
    };
  }, [mobileOpen]);

  if (!hydrated) {
    return <div className="min-h-screen" style={{ background: "var(--color-background)" }}><main id={pathname === "/terms" ? undefined : "main-content"} tabIndex={-1}>{children}</main></div>;
  }

  const isFullWidth = FULL_WIDTH_PATHS.includes(pathname);

  return (
    <div className="min-h-screen" style={{ background: "var(--color-background)" }}>
      {/* Desktop sidebar — hidden on landing page */}
      {!isFullWidth && (
        <div className="hidden lg:block">
          <Sidebar />
        </div>
      )}

      {/* Mobile overlay */}
      {mobileOpen && (
        <dialog
          ref={menuDialog}
          aria-label={t("openMenu")}
          onCancel={(event) => { event.preventDefault(); setMobileOpen(false); }}
          onClose={() => setMobileOpen(false)}
          className="fixed inset-0 z-50 lg:hidden"
          style={{ margin: 0, padding: 0, width: "100vw", maxWidth: "none", height: "100dvh", maxHeight: "none", border: 0, background: "transparent", color: "var(--color-on-surface)" }}
        >
          <div
            className="fixed inset-0"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
            onClick={() => setMobileOpen(false)}
          />
          <div
            className="fixed inset-y-0 start-0 z-50"
            style={{ width: 260, transition: "transform 0.25s ease" }}
          >
            <Sidebar drawer />
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label={t("closeMenu")}
            autoFocus
            className="fixed top-4 z-[70] bv-btn bv-btn-ghost"
            style={{ insetInlineStart: "min(268px, calc(100vw - 56px))", width: 44, height: 44, padding: 0, background: "var(--color-surface)" }}
          ><span aria-hidden="true" className="material-symbols-outlined">close</span></button>
        </dialog>
      )}

      {/* Global overlays */}
      <CommandPalette />
      {!isFullWidth && <PresenceBar />}
      {!isFullWidth && <NotificationBell />}
      {!isFullWidth && <OnboardingChecklist />}

      {/* Main content */}
      <main
        id={pathname === "/terms" ? undefined : "main-content"}
        tabIndex={-1}
        className={`min-h-screen ${!isFullWidth ? "lg:ms-14" : ""}`}
        style={{ background: "var(--color-background)" }}
      >
        {/* Mobile hamburger — hidden on landing page */}
        {!isFullWidth && (
          <button
            ref={menuButton}
            onClick={() => setMobileOpen(true)}
            className="lg:hidden fixed top-4 start-4 z-40 p-2.5 rounded-xl"
            style={{
              background: "var(--color-surface-container-low)",
              border: "1px solid var(--color-outline-variant)",
              color: "var(--color-on-surface)",
              backdropFilter: "blur(12px)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}
            type="button"
            aria-label={t("openMenu")}
            aria-expanded={mobileOpen}
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
