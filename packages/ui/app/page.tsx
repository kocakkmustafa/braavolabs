"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "../lib/store";
import { api } from "../lib/api";

const EXAMPLES = [
  "A content agency that creates and schedules TikTok & LinkedIn posts for 10 clients",
  "An outbound sales team that qualifies leads and books demos automatically",
  "A customer success operation that monitors churn and sends personalized check-ins",
  "A finance back-office that reconciles invoices and generates weekly P&L reports",
];

export default function LandingPage() {
  const token = useAppStore((s) => s.token);
  const [input, setInput] = useState("");
  const [exampleIdx, setExampleIdx] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [charIdx, setCharIdx] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);
  const [companies, setCompanies] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);

  // Typewriter
  useEffect(() => {
    if (input) return;
    const current = EXAMPLES[exampleIdx];
    const speed = isDeleting ? 18 : 38;
    const timer = setTimeout(() => {
      if (!isDeleting) {
        setDisplayText(current.slice(0, charIdx + 1));
        setCharIdx((c) => c + 1);
        if (charIdx + 1 === current.length) setTimeout(() => setIsDeleting(true), 1800);
      } else {
        setDisplayText(current.slice(0, charIdx - 1));
        setCharIdx((c) => c - 1);
        if (charIdx - 1 === 0) { setIsDeleting(false); setExampleIdx((i) => (i + 1) % EXAMPLES.length); }
      }
    }, speed);
    return () => clearTimeout(timer);
  }, [charIdx, isDeleting, exampleIdx, input]);

  // Load dashboard data when panel opens
  useEffect(() => {
    if (!dashOpen || !token) return;
    api.listCompanies(token).then(setCompanies).catch(() => {});
    api.health(token).then(setHealth).catch(() => {});
    api.activityLog(token, 8, 0).then((d) => setLogs(d.logs ?? [])).catch(() => {});
  }, [dashOpen, token]);

  const handleBuild = () => {
    const desc = input.trim();
    const target = token ? "/companies/new" : "/login";
    window.location.href = desc ? `${target}?desc=${encodeURIComponent(desc)}` : target;
  };

  const handleDashClick = () => {
    if (token) setDashOpen(true);
    else window.location.href = "/login";
  };

  return (
    <div style={{ minHeight: "100vh", background: "#10131a", color: "#e1e2eb", overflow: "hidden", position: "relative" }}>

      {/* Ambient orbs */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
        <div style={{ position: "absolute", width: 600, height: 600, borderRadius: "50%", filter: "blur(120px)", opacity: 0.07, background: "radial-gradient(circle, #00d1ff, transparent)", top: -100, left: 0 }} />
        <div style={{ position: "absolute", width: 700, height: 700, borderRadius: "50%", filter: "blur(160px)", opacity: 0.05, background: "radial-gradient(circle, #6d11ad, transparent)", top: "30%", right: dashOpen ? "55%" : -200, transition: "right 0.5s ease" }} />
        <div style={{ position: "absolute", inset: 0, opacity: 0.018, backgroundImage: "radial-gradient(circle, #ffffff 1px, transparent 1px)", backgroundSize: "28px 28px" }} />
      </div>

      {/* Top Nav */}
      <nav style={{ position: "relative", zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 40px", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg, #00d1ff, #6d11ad)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <span style={{ color: "white", fontWeight: 700, fontSize: 11 }}>AI</span>
          </div>
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 14, color: "#e1e2eb" }}>AI Company OS</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 14, color: "#859399" }}>
          <a href="/features" style={{ color: "#859399", textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e1e2eb"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#859399"; }}>Features</a>
          <a href="/pricing" style={{ color: "#859399", textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e1e2eb"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#859399"; }}>Pricing</a>
          <a href="/docs" style={{ color: "#859399", textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e1e2eb"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#859399"; }}>Docs</a>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {!token && <a href="/login" style={{ fontSize: 14, color: "#859399", textDecoration: "none" }}>Sign in</a>}
          <button
            onClick={handleDashClick}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 16px", borderRadius: 12, fontSize: 13, fontWeight: 600,
              background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
              color: "white", border: "none", cursor: "pointer",
              boxShadow: "0 0 16px rgba(0,209,255,0.2)",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>dashboard</span>
            Dashboard
          </button>
        </div>
      </nav>

      {/* Main layout: hero left, dashboard panel right */}
      <div style={{ position: "relative", zIndex: 10, display: "flex", minHeight: "calc(100vh - 80px)" }}>

        {/* LEFT: Hero */}
        <div style={{
          flex: 1,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: "40px 40px 60px",
          transition: "all 0.45s cubic-bezier(0.4,0,0.2,1)",
          maxWidth: dashOpen ? "45%" : "100%",
          minWidth: 0,
        }}>
          <div style={{ width: "100%", maxWidth: 620, textAlign: "center" }}>

            {/* Badge */}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "4px 12px", borderRadius: 999, border: "1px solid rgba(0,209,255,0.25)", background: "rgba(0,209,255,0.06)", marginBottom: 28 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#00d1ff", animation: "pulse 2s infinite" }} />
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", color: "#00d1ff" }}>AUTONOMOUS AI COMPANY PLATFORM</span>
            </div>

            {/* Headline */}
            <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 800, fontSize: "clamp(2rem, 4vw, 3.5rem)", lineHeight: 1.1, letterSpacing: "-0.02em", marginBottom: 16 }}>
              <span style={{ color: "#e1e2eb" }}>Build your AI company</span><br />
              <span style={{ background: "linear-gradient(135deg, #00d1ff 0%, #a4e6ff 40%, #e0b6ff 80%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>in plain English</span>
            </h1>

            <p style={{ color: "#859399", fontSize: "1rem", lineHeight: 1.75, marginBottom: 36, maxWidth: 500, margin: "0 auto 36px" }}>
              Describe what you want to automate. AI builds agents, pipelines, and workflows — running 24/7 with full audit logs.
            </p>

            {/* Builder Input */}
            <div style={{ width: "100%", borderRadius: 16, overflow: "hidden", background: "rgba(29,32,38,0.9)", border: "1px solid rgba(0,209,255,0.15)", boxShadow: "0 0 40px rgba(0,209,255,0.06)", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 20px 8px" }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#00d1ff" }}>smart_toy</span>
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", color: "#00d1ff" }}>AI COMPANY BUILDER</span>
              </div>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBuild(); }}
                rows={4}
                style={{ width: "100%", resize: "none", outline: "none", border: "none", background: "transparent", color: "#e1e2eb", padding: "0 20px 12px", fontSize: 14, lineHeight: 1.7, fontFamily: "inherit", boxSizing: "border-box" }}
                placeholder={displayText + (input ? "" : "▋")}
              />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <span style={{ fontSize: 11, color: "#3c494e" }}>⌘ + Enter to build</span>
                <button
                  onClick={handleBuild}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 10, fontSize: 13, fontWeight: 700, background: "linear-gradient(135deg, #00d1ff, #6d11ad)", color: "white", border: "none", cursor: "pointer", boxShadow: "0 0 20px rgba(0,209,255,0.25)" }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>
                  Build My Company
                </button>
              </div>
            </div>

            {/* Chips */}
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, marginBottom: 36 }}>
              {["Content Agency", "Sales Automation", "Customer Success", "Finance Ops"].map((chip) => (
                <button
                  key={chip}
                  onClick={() => setInput(`An AI-powered ${chip.toLowerCase()} company that automates all key workflows`)}
                  style={{ padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 500, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", color: "#859399", cursor: "pointer" }}
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Stats */}
            <div style={{ display: "flex", justifyContent: "center", gap: 28, flexWrap: "wrap" }}>
              {[{ v: "1,200+", l: "companies built" }, { v: "10 min", l: "to first deploy" }, { v: "100%", l: "actions audited" }].map((s) => (
                <div key={s.l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 14, color: "#e1e2eb" }}>{s.v}</span>
                  <span style={{ fontSize: 12, color: "#3c494e" }}>{s.l}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT: Dashboard slide-in panel */}
        <div style={{
          width: dashOpen ? "55%" : 0,
          minWidth: 0,
          overflow: "hidden",
          transition: "width 0.45s cubic-bezier(0.4,0,0.2,1)",
          flexShrink: 0,
          position: "relative",
        }}>
          <div style={{
            width: "55vw",
            height: "100%",
            background: "rgba(12,12,29,0.98)",
            borderLeft: "1px solid rgba(0,209,255,0.12)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}>
            {/* Panel header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="material-symbols-outlined" style={{ color: "#00d1ff", fontSize: 20 }}>dashboard</span>
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 15, color: "#e1e2eb" }}>Command Center</span>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <a
                  href="/dashboard"
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white", textDecoration: "none" }}
                >
                  Full View <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
                </a>
                <button
                  onClick={() => setDashOpen(false)}
                  style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#859399", cursor: "pointer" }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>
            </div>

            {/* Panel content */}
            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
              {!token ? (
                <div style={{ textAlign: "center", paddingTop: 60 }}>
                  <p style={{ color: "#859399", marginBottom: 16 }}>Sign in to see your dashboard</p>
                  <a href="/login" style={{ padding: "10px 24px", borderRadius: 10, background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white", textDecoration: "none", fontWeight: 600, fontSize: 14 }}>Sign In</a>
                </div>
              ) : (
                <>
                  {/* Stats row */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
                    {[
                      { label: "Companies", value: health?.activeCompanies ?? companies.length, icon: "business", color: "#a4e6ff" },
                      { label: "Running", value: health?.activeRuns ?? 0, icon: "play_circle", color: "#34d399" },
                      { label: "Approvals", value: health?.pendingApprovals ?? 0, icon: "task_alt", color: "#fbbf24" },
                    ].map((m) => (
                      <div key={m.label} style={{ background: "rgba(29,32,38,0.8)", borderRadius: 12, padding: "14px", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 16, color: m.color }}>{m.icon}</span>
                          <span style={{ fontSize: 11, color: "#859399" }}>{m.label}</span>
                        </div>
                        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 22, color: "#e1e2eb" }}>{m.value}</span>
                      </div>
                    ))}
                  </div>

                  {/* Companies list */}
                  <div style={{ background: "rgba(29,32,38,0.8)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)", marginBottom: 12, overflow: "hidden" }}>
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#e1e2eb" }}>Your Companies</span>
                      <a href="/companies" style={{ fontSize: 11, color: "#00d1ff", textDecoration: "none" }}>View all →</a>
                    </div>
                    {companies.length === 0 ? (
                      <div style={{ padding: "24px 16px", textAlign: "center" }}>
                        <p style={{ fontSize: 13, color: "#859399", marginBottom: 10 }}>No companies yet</p>
                        <a href="/companies/new" style={{ fontSize: 12, padding: "6px 14px", borderRadius: 8, background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white", textDecoration: "none", fontWeight: 600 }}>Create First Company</a>
                      </div>
                    ) : (
                      companies.slice(0, 4).map((c: any) => (
                        <a
                          key={c.id}
                          href={`/companies/${c.id}`}
                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", textDecoration: "none", borderBottom: "1px solid rgba(255,255,255,0.03)" }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                        >
                          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#00d1ff,#6d11ad)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 13, fontWeight: 700, color: "white" }}>
                            {c.name?.charAt(0)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: 13, fontWeight: 600, color: "#e1e2eb", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</p>
                            <p style={{ fontSize: 11, color: "#859399", margin: 0 }}>{c.status}</p>
                          </div>
                          <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#3c494e" }}>chevron_right</span>
                        </a>
                      ))
                    )}
                  </div>

                  {/* Activity feed */}
                  <div style={{ background: "rgba(29,32,38,0.8)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" }}>
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#e1e2eb" }}>Recent Activity</span>
                    </div>
                    {logs.length === 0 ? (
                      <div style={{ padding: "20px 16px", textAlign: "center" }}>
                        <p style={{ fontSize: 12, color: "#3c494e" }}>No recent activity</p>
                      </div>
                    ) : (
                      logs.map((log: any) => (
                        <div key={log.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                          <div style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(0,209,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: "#00d1ff" }}>{(log.actor ?? "S").charAt(0).toUpperCase()}</span>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: 12, color: "#bbc9cf", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.action.replace(/\./g, " / ")}</p>
                          </div>
                          <span style={{ fontSize: 11, color: "#3c494e", flexShrink: 0 }}>{timeAgo(log.createdAt)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* How it works (compact, only shown when dashboard closed) */}
      {!dashOpen && (
        <section style={{ position: "relative", zIndex: 10, padding: "0 40px 60px", maxWidth: 900, margin: "0 auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
            {[
              { n: "1", icon: "edit_note", title: "Describe", desc: "Tell Claude what your company does in plain language. Up to 3 clarification rounds." },
              { n: "2", icon: "auto_awesome", title: "AI builds it", desc: "Agents, pipelines, memory, and governance rules — all configured automatically." },
              { n: "3", icon: "trending_up", title: "Runs 24/7", desc: "Every action logged. You approve spend. Full control, zero manual ops." },
            ].map((step) => (
              <div key={step.n} style={{ position: "relative", padding: 18, borderRadius: 14, background: "rgba(29,32,38,0.6)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <span style={{ position: "absolute", top: 12, right: 14, fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#3c494e" }}>{step.n}</span>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#00d1ff" }}>{step.icon}</span>
                </div>
                <p style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 600, fontSize: 13, color: "#e1e2eb", marginBottom: 4 }}>{step.title}</p>
                <p style={{ fontSize: 12, lineHeight: 1.6, color: "#859399" }}>{step.desc}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer style={{ position: "relative", zIndex: 10, padding: "16px 40px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 18, height: 18, borderRadius: 4, background: "linear-gradient(135deg,#00d1ff,#6d11ad)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "white", fontWeight: 700, fontSize: 8 }}>AI</span>
            </div>
            <span style={{ fontSize: 11, color: "#3c494e" }}>AI Company OS</span>
          </div>
          <div style={{ display: "flex", gap: 20, fontSize: 11, color: "#3c494e" }}>
            {[["Features", "/features"], ["Pricing", "/pricing"], ["Privacy", "/privacy"], ["Terms", "/terms"]].map(([l, h]) => (
              <a key={l} href={h} style={{ color: "#3c494e", textDecoration: "none" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#e1e2eb"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#3c494e"; }}>{l}</a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
