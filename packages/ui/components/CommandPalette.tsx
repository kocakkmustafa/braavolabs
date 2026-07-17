"use client";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAppStore } from "../lib/store";
import { api } from "../lib/api";

interface Command {
  id: string;
  /** Static commands carry an i18n key; dynamic (per-workspace) ones carry a literal label. */
  labelKey?: string;
  label?: string;
  icon: string;
  href?: string;
  action?: () => void;
  auth: boolean;
  shortcut?: string;
  category: "navigate" | "action" | "quick" | "company";
}

export default function CommandPalette() {
  const router = useRouter();
  const t = useTranslations();
  const token = useAppStore((s) => s.token);
  const labelOf = (cmd: Command) => (cmd.labelKey ? t(cmd.labelKey) : cmd.label ?? "");
  const [companies, setCompanies] = useState<any[]>([]);
  const companiesFetched = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const COMMANDS: Command[] = [
    // Navigation
    { id: "dashboard", labelKey: "nav.commandCenter", icon: "dashboard", href: "/dashboard", auth: true, shortcut: "D", category: "navigate" },
    { id: "companies", labelKey: "nav.workspaces", icon: "business", href: "/companies", auth: true, shortcut: "C", category: "navigate" },
    { id: "new-company", labelKey: "nav.newWorkspace", icon: "add_circle", href: "/onboarding", auth: true, shortcut: "N", category: "navigate" },
    { id: "pipelines", labelKey: "nav.workflows", icon: "account_tree", href: "/pipelines", auth: true, shortcut: "W", category: "navigate" },
    { id: "approvals", labelKey: "nav.approvals", icon: "task_alt", href: "/approvals", auth: true, shortcut: "A", category: "navigate" },
    { id: "drafts", labelKey: "nav.drafts", icon: "edit_note", href: "/drafts", auth: true, category: "navigate" },
    { id: "analytics", labelKey: "nav.analytics", icon: "query_stats", href: "/analytics", auth: true, category: "navigate" },
    { id: "risks", labelKey: "nav.risks", icon: "security", href: "/risks", auth: true, category: "navigate" },
    { id: "billing", labelKey: "nav.billing", icon: "credit_card", href: "/billing", auth: true, shortcut: "B", category: "navigate" },
    { id: "settings", labelKey: "nav.settings", icon: "settings", href: "/settings", auth: true, shortcut: "S", category: "navigate" },
    // Public
    { id: "features", labelKey: "nav.features", icon: "auto_awesome", href: "/features", auth: false, category: "navigate" },
    { id: "pricing", labelKey: "nav.pricing", icon: "sell", href: "/pricing", auth: false, category: "navigate" },
    // Actions
    { id: "sign-out", labelKey: "app.cmdk.signOut", icon: "logout", auth: true, category: "action", action: () => { void api.signOut().finally(() => router.push("/login")); } },
    { id: "home", labelKey: "app.cmdk.goHome", icon: "home", href: "/", auth: false, category: "quick" },
  ];

  // ⌘K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => {
          const next = !v;
          if (next && token && !companiesFetched.current) {
            api.listCompanies(token).then(setCompanies).catch(() => {});
            companiesFetched.current = true;
          }
          return next;
        });
        setQuery("");
        setSelected(0);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Single-key shortcuts (when palette is NOT open)
  useEffect(() => {
    if (open) return;
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const cmd = COMMANDS.find((c) => c.shortcut?.toLowerCase() === e.key.toLowerCase() && (!c.auth || token));
      if (cmd) {
        e.preventDefault();
        if (cmd.href) router.push(cmd.href);
        else if (cmd.action) cmd.action();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, token]);

  // Dynamic company commands
  const companyCommands: Command[] = companies.map((c) => ({
    id: `company-${c.id}`,
    label: c.name,
    icon: "business",
    href: `/companies/${c.id}`,
    auth: true,
    category: "company" as const,
  }));

  const allCommands = [...COMMANDS, ...companyCommands];

  const filtered = allCommands.filter((c) => {
    if (c.auth && !token) return false;
    if (!query) return c.category !== "company"; // only show workspaces when searching
    return labelOf(c).toLowerCase().includes(query.toLowerCase()) || c.id.includes(query.toLowerCase());
  });

  useEffect(() => { setSelected(0); }, [query]);

  const handleSelect = (cmd: Command) => {
    setOpen(false);
    if (cmd.action) cmd.action();
    else if (cmd.href) router.push(cmd.href);
  };

  if (!open) return null;

  // Group by category
  const grouped: Record<string, Command[]> = {};
  filtered.forEach((cmd) => {
    if (!grouped[cmd.category]) grouped[cmd.category] = [];
    grouped[cmd.category].push(cmd);
  });

  const categoryLabels: Record<string, string> = {
    navigate: t("app.cmdk.catPages"),
    action: t("app.cmdk.catActions"),
    quick: t("app.cmdk.catQuick"),
    company: t("app.cmdk.catWorkspaces"),
  };

  let flatIndex = 0;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={() => setOpen(false)}
    >
      <div
        style={{ width: "100%", maxWidth: 560, borderRadius: 16, overflow: "hidden", background: "#191c22", border: "1px solid rgba(0,209,255,0.2)", boxShadow: "0 24px 60px rgba(0,0,0,0.5)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <span className="material-symbols-outlined" style={{ color: "#859399", fontSize: 20 }}>search</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && filtered[selected]) handleSelect(filtered[selected]);
            }}
            placeholder={t("app.cmdk.searchPlaceholder")}
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 15, color: "#e1e2eb" }}
          />
          <kbd style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "rgba(255,255,255,0.06)", color: "#859399", border: "1px solid rgba(255,255,255,0.08)" }}>ESC</kbd>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 400, overflowY: "auto", padding: "6px 0" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "24px 18px", textAlign: "center", color: "#3c494e", fontSize: 13 }}>{t("app.cmdk.noResults")}</div>
          ) : (
            Object.entries(grouped).map(([category, cmds]) => (
              <div key={category}>
                <div style={{ padding: "8px 18px 4px", fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", color: "#3c494e" }}>
                  {categoryLabels[category] ?? category.toUpperCase()}
                </div>
                {cmds.map((cmd) => {
                  const idx = flatIndex++;
                  return (
                    <button
                      key={cmd.id}
                      onClick={() => handleSelect(cmd)}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 12,
                        padding: "10px 18px", border: "none", cursor: "pointer", textAlign: "left",
                        background: idx === selected ? "rgba(0,209,255,0.08)" : "transparent",
                        borderLeft: idx === selected ? "2px solid #00d1ff" : "2px solid transparent",
                        color: idx === selected ? "#e1e2eb" : "#bbc9cf",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={() => setSelected(idx)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: idx === selected ? "#00d1ff" : "#859399" }}>{cmd.icon}</span>
                      <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>{labelOf(cmd)}</span>
                      {cmd.shortcut && (
                        <kbd style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "rgba(255,255,255,0.06)", color: "#3c494e", border: "1px solid rgba(255,255,255,0.08)" }}>
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div style={{ padding: "8px 18px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 16 }}>
          {[["↑↓", t("app.cmdk.hintNavigate")], ["↵", t("app.cmdk.hintOpen")], ["esc", t("app.cmdk.hintClose")], ["D", t("app.cmdk.hintDashboard")], ["N", t("app.cmdk.hintNewWorkspace")]].map(([k, l]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <kbd style={{ fontSize: 10, padding: "2px 5px", borderRadius: 4, background: "rgba(255,255,255,0.06)", color: "#859399", border: "1px solid rgba(255,255,255,0.08)" }}>{k}</kbd>
              <span style={{ fontSize: 11, color: "#3c494e" }}>{l}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
