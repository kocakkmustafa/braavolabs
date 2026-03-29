"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAppStore } from "../lib/store";

const EXAMPLES = [
  "A content agency that creates and schedules TikTok & LinkedIn posts for 10 clients",
  "An outbound sales team that qualifies leads and books demos automatically",
  "A customer success operation that monitors churn and sends personalized check-ins",
  "A finance back-office that reconciles invoices and generates weekly P&L reports",
];

// ── Agent room animation ─────────────────────────────────────────────────────

const AGENTS = [
  { id: 1, label: "Acquisition", icon: "🎯", x: 0.12, y: 0.22 },
  { id: 2, label: "Sales",       icon: "💼", x: 0.28, y: 0.55 },
  { id: 3, label: "Content",     icon: "✍️", x: 0.18, y: 0.72 },
  { id: 4, label: "Delivery",    icon: "🚀", x: 0.50, y: 0.30 },
  { id: 5, label: "Finance",     icon: "📊", x: 0.72, y: 0.60 },
  { id: 6, label: "Memory",      icon: "🧠", x: 0.62, y: 0.18 },
  { id: 7, label: "Analytics",   icon: "📈", x: 0.85, y: 0.35 },
  { id: 8, label: "Governance",  icon: "🛡️", x: 0.78, y: 0.78 },
  { id: 9, label: "Ops",         icon: "⚙️", x: 0.40, y: 0.78 },
];

const CONNECTIONS = [
  [1, 4], [4, 6], [6, 7], [4, 5],
  [1, 2], [2, 4], [2, 3], [3, 9],
  [9, 5], [5, 8], [7, 5], [6, 4],
];

const MESSAGES = [
  "Lead scored → 0.87",
  "Post scheduled → TikTok",
  "Invoice reconciled",
  "Demo booked",
  "Memory updated",
  "Budget check → OK",
  "Risk: none",
  "Content approved",
  "CRM sync done",
];

function AgentCanvas({ theme }: { theme: "dark" | "light" }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<any[]>([]);
  const messagesRef = useRef<any[]>([]);
  const tickRef = useRef(0);

  const isDark = theme === "dark";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    resize();
    window.addEventListener("resize", resize);

    const W = () => canvas.offsetWidth;
    const H = () => canvas.offsetHeight;

    // Spawn a particle along a connection
    const spawnParticle = () => {
      const conn = CONNECTIONS[Math.floor(Math.random() * CONNECTIONS.length)];
      const from = AGENTS.find((a) => a.id === conn[0])!;
      const to = AGENTS.find((a) => a.id === conn[1])!;
      particlesRef.current.push({
        fromX: from.x, fromY: from.y,
        toX: to.x, toY: to.y,
        t: 0, speed: 0.004 + Math.random() * 0.004,
        color: Math.random() > 0.5 ? "#00d1ff" : "#6d11ad",
        size: 2.5 + Math.random() * 1.5,
      });
    };

    const spawnMessage = () => {
      const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
      const msg = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
      messagesRef.current.push({
        x: agent.x, y: agent.y,
        text: msg,
        alpha: 0,
        life: 0,
        maxLife: 140,
      });
    };

    const draw = () => {
      tickRef.current++;
      ctx.clearRect(0, 0, W(), H());

      const w = W(), h = H();

      // Background grid
      ctx.strokeStyle = isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.04)";
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y < h; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Connection lines
      CONNECTIONS.forEach(([fromId, toId]) => {
        const from = AGENTS.find((a) => a.id === fromId)!;
        const to = AGENTS.find((a) => a.id === toId)!;
        ctx.beginPath();
        ctx.moveTo(from.x * w, from.y * h);
        ctx.lineTo(to.x * w, to.y * h);
        ctx.strokeStyle = isDark ? "rgba(0,209,255,0.07)" : "rgba(0,209,255,0.12)";
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Particles
      particlesRef.current = particlesRef.current.filter((p) => p.t <= 1);
      particlesRef.current.forEach((p) => {
        p.t += p.speed;
        const px = (p.fromX + (p.toX - p.fromX) * p.t) * w;
        const py = (p.fromY + (p.toY - p.fromY) * p.t) * h;
        const alpha = p.t < 0.1 ? p.t * 10 : p.t > 0.9 ? (1 - p.t) * 10 : 1;
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + Math.round(alpha * 180).toString(16).padStart(2, "0");
        ctx.fill();
        // glow
        ctx.beginPath();
        ctx.arc(px, py, p.size * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = p.color + Math.round(alpha * 30).toString(16).padStart(2, "0");
        ctx.fill();
      });

      // Agent nodes
      AGENTS.forEach((agent) => {
        const ax = agent.x * w;
        const ay = agent.y * h;
        const pulse = 0.85 + 0.15 * Math.sin(tickRef.current * 0.04 + agent.id);

        // Outer ring
        ctx.beginPath();
        ctx.arc(ax, ay, 22 * pulse, 0, Math.PI * 2);
        ctx.strokeStyle = isDark ? "rgba(0,209,255,0.15)" : "rgba(0,209,255,0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Node bg
        ctx.beginPath();
        ctx.arc(ax, ay, 16, 0, Math.PI * 2);
        ctx.fillStyle = isDark ? "rgba(29,32,38,0.95)" : "rgba(240,245,255,0.95)";
        ctx.fill();
        ctx.strokeStyle = isDark ? "rgba(0,209,255,0.3)" : "rgba(0,209,255,0.5)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Icon
        ctx.font = "12px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(agent.icon, ax, ay);

        // Label
        ctx.font = "9px 'Space Grotesk', sans-serif";
        ctx.fillStyle = isDark ? "rgba(133,147,153,0.8)" : "rgba(60,73,78,0.9)";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(agent.label, ax, ay + 20);
      });

      // Floating messages
      if (tickRef.current % 90 === 0) spawnMessage();
      messagesRef.current = messagesRef.current.filter((m) => m.life < m.maxLife);
      messagesRef.current.forEach((m) => {
        m.life++;
        m.alpha = m.life < 20 ? m.life / 20 : m.life > 100 ? (m.maxLife - m.life) / 40 : 1;
        const mx = m.x * w + 24;
        const my = m.y * h - 28 - (m.life * 0.15);

        ctx.fillStyle = isDark
          ? `rgba(12,14,22,${m.alpha * 0.92})`
          : `rgba(240,246,255,${m.alpha * 0.95})`;
        const tw = ctx.measureText(m.text).width + 16;
        roundRect(ctx, mx, my - 10, tw, 20, 5);
        ctx.fill();
        ctx.strokeStyle = `rgba(0,209,255,${m.alpha * 0.3})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();

        ctx.font = "10px 'Space Grotesk', sans-serif";
        ctx.fillStyle = isDark
          ? `rgba(0,209,255,${m.alpha})`
          : `rgba(0,100,180,${m.alpha})`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(m.text, mx + 8, my);
      });

      // Spawn particles
      if (tickRef.current % 18 === 0) spawnParticle();

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [isDark]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const token = useAppStore((s) => s.token);
  const [input, setInput] = useState("");
  const [exampleIdx, setExampleIdx] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [charIdx, setCharIdx] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const theme = useAppStore((s) => s.theme);

  const isDark = theme === "dark";
  const bg = isDark ? "#10131a" : "#f0f5ff";
  const surface = isDark ? "rgba(29,32,38,0.9)" : "rgba(255,255,255,0.9)";
  const textPrimary = isDark ? "#e1e2eb" : "#0c1520";
  const textMuted = isDark ? "#859399" : "#4a5568";
  const textFaint = isDark ? "#3c494e" : "#9aa5b4";
  const borderColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";

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

  const router = useRouter();

  const handleBuild = () => {
    const desc = input.trim();
    if (desc) {
      try { sessionStorage.setItem("aicos-build-desc", desc); } catch {}
    }
    const target = token ? "/companies/new" : "/login";
    router.push(desc ? `${target}?desc=${encodeURIComponent(desc)}` : target);
  };

  return (
    <div style={{ minHeight: "100vh", background: bg, color: textPrimary, overflow: "hidden", position: "relative", transition: "background 0.3s" }}>

      {/* Ambient orbs — dark only */}
      {isDark && (
        <div style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
          <div style={{ position: "absolute", width: 600, height: 600, borderRadius: "50%", filter: "blur(120px)", opacity: 0.06, background: "radial-gradient(circle, #00d1ff, transparent)", top: -100, left: 0 }} />
          <div style={{ position: "absolute", width: 700, height: 700, borderRadius: "50%", filter: "blur(160px)", opacity: 0.04, background: "radial-gradient(circle, #6d11ad, transparent)", top: "30%", right: -200 }} />
        </div>
      )}

      {/* Top Nav */}
      <nav style={{ position: "relative", zIndex: 20, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 32px", borderBottom: `1px solid ${borderColor}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg, #00d1ff, #6d11ad)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <span style={{ color: "white", fontWeight: 700, fontSize: 11 }}>AI</span>
          </div>
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 14, color: textPrimary }}>AI Company OS</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 14, color: textMuted }}>
          <Link href="/features" style={{ color: textMuted, textDecoration: "none" }}>Features</Link>
          <Link href="/pricing" style={{ color: textMuted, textDecoration: "none" }}>Pricing</Link>
          <Link href="/docs" style={{ color: textMuted, textDecoration: "none" }}>Docs</Link>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!token && (
            <Link href="/login" style={{ fontSize: 13, color: textMuted, textDecoration: "none", padding: "6px 12px" }}>Sign in</Link>
          )}

          <Link
            href="/dashboard"
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 16px", borderRadius: 12, fontSize: 13, fontWeight: 600,
              background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
              color: "white", textDecoration: "none",
              boxShadow: "0 0 16px rgba(0,209,255,0.2)",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>dashboard</span>
            Dashboard
          </Link>
        </div>
      </nav>

      {/* ── SPLIT LAYOUT ── */}
      <div style={{ position: "relative", zIndex: 10, display: "flex", height: "calc(100vh - 65px)" }}>

        {/* LEFT: Hero (75%) */}
        <div style={{
          flex: "0 0 75%",
          overflow: "hidden",
          position: "relative",
        }}>
          {/* Agent animation background */}
          <AgentCanvas theme={theme} />

          {/* Hero content — centered with slight upward offset */}
          <div style={{
            position: "relative", zIndex: 2,
            height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            padding: "0 40px",
            paddingBottom: "6vh",
          }}>
            <div style={{ width: "100%", maxWidth: 580, textAlign: "center" }}>

              {/* Badge */}
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "4px 14px", borderRadius: 999, border: "1px solid rgba(0,209,255,0.3)", background: "rgba(0,209,255,0.07)", marginBottom: 24 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#00d1ff", boxShadow: "0 0 6px #00d1ff", animation: "pulse 2s infinite" }} />
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", color: "#00d1ff" }}>9 AI AGENTS. ONE COMPANY.</span>
              </div>

              {/* Headline */}
              <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 900, fontSize: "clamp(2.2rem, 4.5vw, 3.8rem)", lineHeight: 1.05, letterSpacing: "-0.03em", marginBottom: 18 }}>
                <span style={{ color: textPrimary }}>Your company,</span><br />
                <span style={{ background: "linear-gradient(135deg, #00d1ff 0%, #a4e6ff 40%, #e0b6ff 80%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>running itself.</span>
              </h1>

              <p style={{ color: textMuted, fontSize: "0.95rem", lineHeight: 1.8, marginBottom: 32, maxWidth: 460, margin: "0 auto 32px" }}>
                Describe what you want to automate. AI builds agents, pipelines, and workflows — running 24/7 with full audit logs.
              </p>

              {/* Builder Input */}
              <div style={{ width: "100%", borderRadius: 16, overflow: "hidden", background: surface, border: `1px solid rgba(0,209,255,0.18)`, boxShadow: isDark ? "0 0 48px rgba(0,209,255,0.07)" : "0 4px 32px rgba(0,0,0,0.08)", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 18px 6px" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 17, color: "#00d1ff" }}>smart_toy</span>
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", color: "#00d1ff" }}>AI COMPANY BUILDER</span>
                </div>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBuild(); }}
                  rows={3}
                  style={{ width: "100%", resize: "none", outline: "none", border: "none", background: "transparent", color: textPrimary, padding: "4px 18px 10px", fontSize: 14, lineHeight: 1.7, fontFamily: "inherit", boxSizing: "border-box" }}
                  placeholder={displayText + (input ? "" : "▋")}
                />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderTop: `1px solid ${borderColor}` }}>
                  <span style={{ fontSize: 11, color: textFaint }}>⌘ + Enter to build</span>
                  <button
                    onClick={handleBuild}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 18px", borderRadius: 10, fontSize: 13, fontWeight: 700, background: "linear-gradient(135deg, #00d1ff, #6d11ad)", color: "white", border: "none", cursor: "pointer", boxShadow: "0 0 20px rgba(0,209,255,0.25)" }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>rocket_launch</span>
                    Build My Company
                  </button>
                </div>
              </div>

              {/* Chips */}
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, marginBottom: 28 }}>
                {["Content Agency", "Sales Automation", "Customer Success", "Finance Ops"].map((chip) => (
                  <button
                    key={chip}
                    onClick={() => setInput(`An AI-powered ${chip.toLowerCase()} company that automates all key workflows`)}
                    style={{ padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 500, background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)", border: `1px solid ${borderColor}`, color: textMuted, cursor: "pointer" }}
                  >
                    {chip}
                  </button>
                ))}
              </div>

              {/* Stats */}
              <div style={{ display: "flex", justifyContent: "center", gap: 28, flexWrap: "wrap" }}>
                {[{ v: "1,200+", l: "companies built" }, { v: "10 min", l: "to first deploy" }, { v: "100%", l: "actions audited" }].map((s) => (
                  <div key={s.l} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 13, color: textPrimary }}>{s.v}</span>
                    <span style={{ fontSize: 11, color: textFaint }}>{s.l}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Dashboard side panel (25%) */}
        <div style={{
          flex: "0 0 25%",
          background: isDark ? "rgba(12,12,29,0.97)" : "rgba(230,238,255,0.97)",
          borderLeft: `1px solid ${isDark ? "rgba(0,209,255,0.1)" : "rgba(0,209,255,0.2)"}`,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Panel header */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 20px", borderBottom: `1px solid ${borderColor}`, flexShrink: 0 }}>
            <span className="material-symbols-outlined" style={{ color: "#00d1ff", fontSize: 18 }}>dashboard</span>
            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 14, color: textPrimary }}>Dashboard</span>
          </div>

          {/* Panel body — static overview cards */}
          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Live status indicators */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { label: "Agents", value: "9", icon: "smart_toy", color: "#00d1ff" },
                { label: "Uptime", value: "99.9%", icon: "check_circle", color: "#34d399" },
              ].map((m) => (
                <div key={m.label} style={{ background: isDark ? "rgba(29,32,38,0.7)" : "rgba(255,255,255,0.7)", borderRadius: 10, padding: 12, border: `1px solid ${borderColor}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 13, color: m.color }}>{m.icon}</span>
                    <span style={{ fontSize: 10, color: textMuted }}>{m.label}</span>
                  </div>
                  <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 18, color: textPrimary }}>{m.value}</span>
                </div>
              ))}
            </div>

            {/* Quick features list */}
            <div style={{ background: isDark ? "rgba(29,32,38,0.6)" : "rgba(255,255,255,0.7)", borderRadius: 10, border: `1px solid ${borderColor}`, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${borderColor}` }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: textPrimary }}>Control Center</span>
              </div>
              {[
                { icon: "business", label: "AI Companies", desc: "Create & manage", color: "#a4e6ff" },
                { icon: "account_tree", label: "Pipelines", desc: "Workflows & runs", color: "#34d399" },
                { icon: "task_alt", label: "Approvals", desc: "Spend reviews", color: "#fbbf24" },
                { icon: "query_stats", label: "Analytics", desc: "Performance data", color: "#c084fc" },
                { icon: "security", label: "Risk Shield", desc: "Governance", color: "#f87171" },
              ].map((item) => (
                <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: `1px solid ${borderColor}` }}>
                  <div style={{ width: 28, height: 28, borderRadius: 7, background: `${item.color}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 14, color: item.color }}>{item.icon}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 11, fontWeight: 600, color: textPrimary, margin: 0 }}>{item.label}</p>
                    <p style={{ fontSize: 9, color: textFaint, margin: 0 }}>{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Live activity pulse */}
            <div style={{ background: isDark ? "rgba(29,32,38,0.6)" : "rgba(255,255,255,0.7)", borderRadius: 10, border: `1px solid ${borderColor}`, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399", boxShadow: "0 0 6px #34d399", animation: "pulse 2s infinite" }} />
                <span style={{ fontSize: 10, fontWeight: 600, color: "#34d399" }}>LIVE</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  "Content published → TikTok",
                  "Lead scored → 0.92",
                  "Pipeline completed",
                ].map((msg, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 4, height: 4, borderRadius: "50%", background: textFaint, flexShrink: 0 }} />
                    <span style={{ fontSize: 10, color: textMuted }}>{msg}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Spacer */}
            <div style={{ flex: 1 }} />

            {/* CTA — enter dashboard */}
            <Link
              href={token ? "/dashboard" : "/login"}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                padding: "14px 16px", borderRadius: 14,
                background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
                color: "white", textDecoration: "none", fontWeight: 700, fontSize: 13,
                boxShadow: "0 0 24px rgba(0,209,255,0.2)",
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 32px rgba(0,209,255,0.35)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 0 24px rgba(0,209,255,0.2)"; }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>login</span>
              {token ? "Enter Command Center" : "Sign In to Start"}
            </Link>
          </div>
        </div>
      </div>

      {/* Social proof / Trust section */}
      {(
        <section style={{ position: "relative", zIndex: 10, padding: "0 32px 24px" }}>
          {/* How it works */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, maxWidth: 800, margin: "0 auto 24px" }}>
            {[
              { n: "1", icon: "edit_note", title: "Describe", desc: "Tell Claude what your company does. Up to 3 clarification rounds." },
              { n: "2", icon: "auto_awesome", title: "AI Builds", desc: "Agents, pipelines, memory — all configured automatically." },
              { n: "3", icon: "trending_up", title: "Runs 24/7", desc: "Full audit log. You approve spend. Zero manual ops." },
            ].map((step) => (
              <div key={step.n} style={{ position: "relative", padding: 16, borderRadius: 12, background: surface, border: `1px solid ${borderColor}` }}>
                <span style={{ position: "absolute", top: 10, right: 12, fontFamily: "monospace", fontSize: 10, fontWeight: 700, color: textFaint }}>{step.n}</span>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#00d1ff" }}>{step.icon}</span>
                </div>
                <p style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 600, fontSize: 12, color: textPrimary, marginBottom: 3 }}>{step.title}</p>
                <p style={{ fontSize: 11, lineHeight: 1.5, color: textMuted }}>{step.desc}</p>
              </div>
            ))}
          </div>

          {/* Trust badges */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 32, flexWrap: "wrap" }}>
            {[
              { icon: "shield", text: "SOC 2 Ready" },
              { icon: "lock", text: "End-to-end Encrypted" },
              { icon: "verified", text: "Full Audit Trail" },
              { icon: "speed", text: "99.9% Uptime SLA" },
            ].map((badge) => (
              <div key={badge.text} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 14, color: textFaint }}>{badge.icon}</span>
                <span style={{ fontSize: 10, color: textFaint }}>{badge.text}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer style={{ position: "relative", zIndex: 10, padding: "12px 32px", borderTop: `1px solid ${borderColor}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 16, height: 16, borderRadius: 3, background: "linear-gradient(135deg,#00d1ff,#6d11ad)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "white", fontWeight: 700, fontSize: 7 }}>AI</span>
            </div>
            <span style={{ fontSize: 11, color: textFaint }}>AI Company OS</span>
          </div>
          <div style={{ display: "flex", gap: 18, fontSize: 11, color: textFaint }}>
            {[["Features", "/features"], ["Pricing", "/pricing"], ["Privacy", "/privacy"], ["Terms", "/terms"]].map(([l, h]) => (
              <Link key={l} href={h} style={{ color: textFaint, textDecoration: "none" }}>{l}</Link>
            ))}
          </div>
        </div>
      </footer>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(0.85); }
        }
      `}</style>
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
