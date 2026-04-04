"use client";
import { useEffect, useState } from "react";
import { useAppStore } from "../lib/store";
import { api } from "../lib/api";

export default function NotificationBell() {
  const token = useAppStore((s) => s.token);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [approvals, setApprovals] = useState<any[]>([]);

  const isDark = theme === "dark";

  // Sync theme to document class so CSS variables switch
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
      root.classList.remove("light");
      root.style.colorScheme = "dark";
    } else {
      root.classList.remove("dark");
      root.classList.add("light");
      root.style.colorScheme = "light";
    }
  }, [isDark]);

  useEffect(() => {
    if (!token) return;
    const fetchData = () => {
      api.listApprovals(token, "PENDING")
        .then((data) => {
          setCount(Array.isArray(data) ? data.length : 0);
          setApprovals(Array.isArray(data) ? data.slice(0, 5) : []);
        })
        .catch(() => {});
    };
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [token]);

  if (!token) return null;

  const btnStyle = {
    width: 36, height: 36, borderRadius: 10,
    background: isDark ? "rgba(29,32,38,0.9)" : "rgba(255,255,255,0.9)",
    border: isDark ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.1)",
    cursor: "pointer" as const, display: "flex", alignItems: "center", justifyContent: "center",
    color: isDark ? "#859399" : "#4a5568",
  };

  return (
    <div style={{ position: "fixed", top: 16, right: 20, zIndex: 100, display: "flex", gap: 8 }}>
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        title={isDark ? "Light mode" : "Dark mode"}
        style={btnStyle}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
          {isDark ? "light_mode" : "dark_mode"}
        </span>
      </button>

      {/* Bell */}
      <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ ...btnStyle, position: "relative" }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>notifications</span>
        {count > 0 && (
          <span style={{ position: "absolute", top: -4, right: -4, width: 16, height: 16, borderRadius: "50%", background: "#ef4444", fontSize: 9, fontWeight: 700, color: "white", display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${isDark ? "#0a0d14" : "#f0f5ff"}` }}>
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div style={{ position: "fixed", inset: 0 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: 44, right: 0, width: 300, borderRadius: 14, background: "#191c22", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)", overflow: "hidden", zIndex: 101 }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#e1e2eb" }}>Notifications</span>
              {count > 0 && (
                <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 999, background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" }}>
                  {count} pending
                </span>
              )}
            </div>
            {approvals.length === 0 ? (
              <div style={{ padding: "24px 16px", textAlign: "center" }}>
                <span className="material-symbols-outlined" style={{ fontSize: 28, color: "#3c494e", display: "block", marginBottom: 6 }}>notifications_off</span>
                <p style={{ fontSize: 12, color: "#859399" }}>All clear — no pending approvals</p>
              </div>
            ) : (
              approvals.map((a: any) => (
                <a
                  key={a.id}
                  href="/approvals"
                  style={{ display: "block", padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.04)", textDecoration: "none" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <p style={{ fontSize: 12, fontWeight: 600, color: "#fbbf24", margin: "0 0 2px" }}>Spend Approval Required</p>
                  <p style={{ fontSize: 11, color: "#859399", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.description ?? a.action}</p>
                  {a.amountUsd && <p style={{ fontSize: 11, color: "#34d399", margin: "2px 0 0" }}>${Number(a.amountUsd).toFixed(2)}</p>}
                </a>
              ))
            )}
            <div style={{ padding: "8px 12px" }}>
              <a
                href="/approvals"
                style={{ display: "block", textAlign: "center", padding: "7px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", color: "#bbc9cf", textDecoration: "none" }}
              >
                View All Approvals
              </a>
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}
