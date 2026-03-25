"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppStore } from "../lib/store";

const COMMANDS = [
  { id: "dashboard", label: "Command Center", icon: "dashboard", href: "/dashboard", auth: true },
  { id: "companies", label: "AI Companies", icon: "business", href: "/companies", auth: true },
  { id: "new-company", label: "New Company", icon: "add_circle", href: "/companies/new", auth: true },
  { id: "approvals", label: "Approvals", icon: "task_alt", href: "/approvals", auth: true },
  { id: "drafts", label: "Drafts", icon: "edit_note", href: "/drafts", auth: true },
  { id: "analytics", label: "Analytics", icon: "query_stats", href: "/analytics", auth: true },
  { id: "risks", label: "Risk Shield", icon: "security", href: "/risks", auth: true },
  { id: "settings", label: "Settings", icon: "settings", href: "/settings", auth: true },
  { id: "features", label: "Features", icon: "auto_awesome", href: "/features", auth: false },
  { id: "pricing", label: "Pricing", icon: "sell", href: "/pricing", auth: false },
  { id: "docs", label: "Documentation", icon: "menu_book", href: "/docs", auth: false },
];

export default function CommandPalette() {
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setSelected(0);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const filtered = COMMANDS.filter((c) => {
    if (c.auth && !token) return false;
    return c.label.toLowerCase().includes(query.toLowerCase());
  });

  useEffect(() => { setSelected(0); }, [query]);

  const handleSelect = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  if (!open) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "15vh", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
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
              if (e.key === "Enter" && filtered[selected]) handleSelect(filtered[selected].href);
            }}
            placeholder="Search pages and actions..."
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 15, color: "#e1e2eb" }}
          />
          <kbd style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "rgba(255,255,255,0.06)", color: "#859399", border: "1px solid rgba(255,255,255,0.08)" }}>ESC</kbd>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 360, overflowY: "auto", padding: "6px 0" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "24px 18px", textAlign: "center", color: "#3c494e", fontSize: 13 }}>No results found</div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                onClick={() => handleSelect(cmd.href)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 18px", border: "none", cursor: "pointer", textAlign: "left",
                  background: i === selected ? "rgba(0,209,255,0.08)" : "transparent",
                  borderLeft: i === selected ? "2px solid #00d1ff" : "2px solid transparent",
                  color: i === selected ? "#e1e2eb" : "#bbc9cf",
                  transition: "background 0.1s",
                }}
                onMouseEnter={() => setSelected(i)}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: i === selected ? "#00d1ff" : "#859399" }}>{cmd.icon}</span>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{cmd.label}</span>
              </button>
            ))
          )}
        </div>

        <div style={{ padding: "8px 18px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 16 }}>
          {[["↑↓", "navigate"], ["↵", "open"], ["esc", "close"]].map(([k, l]) => (
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
