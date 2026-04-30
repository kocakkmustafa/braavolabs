"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAppStore } from "../lib/store";
import { sounds } from "../lib/sounds";
import { useReveal } from "../lib/useReveal";
import LanguageSwitcher from "../components/LanguageSwitcher";

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
  "Video generated",
  "Image created → DALL-E",
  "Pipeline completed",
];

function AgentCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<any[]>([]);
  const messagesRef = useRef<any[]>([]);
  const tickRef = useRef(0);

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

    const spawnParticle = () => {
      const conn = CONNECTIONS[Math.floor(Math.random() * CONNECTIONS.length)];
      const from = AGENTS.find((a) => a.id === conn[0])!;
      const to = AGENTS.find((a) => a.id === conn[1])!;
      particlesRef.current.push({
        fromX: from.x, fromY: from.y,
        toX: to.x, toY: to.y,
        t: 0, speed: 0.003 + Math.random() * 0.004,
        color: Math.random() > 0.4 ? "#00d1ff" : "#a855f7",
        size: 2 + Math.random() * 2,
      });
    };

    const spawnMessage = () => {
      const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
      const msg = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
      messagesRef.current.push({
        x: agent.x, y: agent.y, text: msg,
        alpha: 0, life: 0, maxLife: 160,
      });
    };

    const draw = () => {
      tickRef.current++;
      const w = W(), h = H();
      ctx.clearRect(0, 0, w, h);

      // Grid with breathing opacity
      const gridAlpha = 0.02 + 0.01 * Math.sin(tickRef.current * 0.008);
      ctx.strokeStyle = `rgba(255,255,255,${gridAlpha})`;
      ctx.lineWidth = 0.5;
      for (let x = 0; x < w; x += 50) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y < h; y += 50) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Connection lines with gradient
      CONNECTIONS.forEach(([fromId, toId]) => {
        const from = AGENTS.find((a) => a.id === fromId)!;
        const to = AGENTS.find((a) => a.id === toId)!;
        const grad = ctx.createLinearGradient(from.x * w, from.y * h, to.x * w, to.y * h);
        grad.addColorStop(0, "rgba(0,209,255,0.06)");
        grad.addColorStop(1, "rgba(168,85,247,0.04)");
        ctx.beginPath();
        ctx.moveTo(from.x * w, from.y * h);
        ctx.lineTo(to.x * w, to.y * h);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Particles with trail
      particlesRef.current = particlesRef.current.filter((p) => p.t <= 1);
      particlesRef.current.forEach((p) => {
        p.t += p.speed;
        const px = (p.fromX + (p.toX - p.fromX) * p.t) * w;
        const py = (p.fromY + (p.toY - p.fromY) * p.t) * h;
        const alpha = p.t < 0.1 ? p.t * 10 : p.t > 0.9 ? (1 - p.t) * 10 : 1;

        // Trail
        const prevT = Math.max(0, p.t - 0.08);
        const prevX = (p.fromX + (p.toX - p.fromX) * prevT) * w;
        const prevY = (p.fromY + (p.toY - p.fromY) * prevT) * h;
        const trailGrad = ctx.createLinearGradient(prevX, prevY, px, py);
        const alphaHex = Math.max(0, Math.min(255, Math.round(alpha * 140))).toString(16).padStart(2, "0");
        trailGrad.addColorStop(0, `${p.color}00`);
        trailGrad.addColorStop(1, `${p.color}${alphaHex}`);
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(px, py);
        ctx.strokeStyle = trailGrad;
        ctx.lineWidth = p.size * 0.8;
        ctx.stroke();

        // Core
        const coreHex = Math.max(0, Math.min(255, Math.round(alpha * 220))).toString(16).padStart(2, "0");
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `${p.color}${coreHex}`;
        ctx.fill();

        // Glow
        ctx.beginPath();
        ctx.arc(px, py, p.size * 3, 0, Math.PI * 2);
        ctx.fillStyle = p.color + Math.round(alpha * 20).toString(16).padStart(2, "0");
        ctx.fill();
      });

      // Agent nodes
      AGENTS.forEach((agent) => {
        const ax = agent.x * w;
        const ay = agent.y * h;
        const pulse = 0.85 + 0.15 * Math.sin(tickRef.current * 0.03 + agent.id * 0.7);
        const breathe = 1 + 0.03 * Math.sin(tickRef.current * 0.02 + agent.id * 1.3);

        // Outer glow ring
        ctx.beginPath();
        ctx.arc(ax, ay, 26 * pulse, 0, Math.PI * 2);
        const ringGrad = ctx.createRadialGradient(ax, ay, 12, ax, ay, 26 * pulse);
        ringGrad.addColorStop(0, "rgba(0,209,255,0)");
        ringGrad.addColorStop(1, `rgba(0,209,255,${0.08 * pulse})`);
        ctx.fillStyle = ringGrad;
        ctx.fill();

        // Node bg
        ctx.beginPath();
        ctx.arc(ax, ay, 17 * breathe, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(10,13,20,0.95)";
        ctx.fill();
        ctx.strokeStyle = `rgba(0,209,255,${0.2 + 0.1 * pulse})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Icon
        ctx.font = "13px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(agent.icon, ax, ay);

        // Label
        ctx.font = "500 9px 'Space Grotesk', sans-serif";
        ctx.fillStyle = `rgba(164,230,255,${0.6 + 0.2 * pulse})`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(agent.label, ax, ay + 22);
      });

      // Floating messages
      if (tickRef.current % 80 === 0) spawnMessage();
      messagesRef.current = messagesRef.current.filter((m) => m.life < m.maxLife);
      messagesRef.current.forEach((m) => {
        m.life++;
        m.alpha = m.life < 20 ? m.life / 20 : m.life > 120 ? (m.maxLife - m.life) / 40 : 1;
        const mx = m.x * w + 26;
        const my = m.y * h - 30 - (m.life * 0.18);

        const tw = ctx.measureText(m.text).width + 20;
        roundRect(ctx, mx, my - 11, tw, 22, 6);
        ctx.fillStyle = `rgba(10,13,20,${m.alpha * 0.94})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(0,209,255,${m.alpha * 0.2})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();

        ctx.font = "500 10px 'Space Grotesk', sans-serif";
        ctx.fillStyle = `rgba(164,230,255,${m.alpha * 0.9})`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(m.text, mx + 10, my);
      });

      // Spawn particles
      if (tickRef.current % 14 === 0) spawnParticle();
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

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
  const t = useTranslations();
  const token = useAppStore((s) => s.token);
  const [input, setInput] = useState("");
  const [exampleIdx, setExampleIdx] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [charIdx, setCharIdx] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [heroVisible, setHeroVisible] = useState(false);
  const router = useRouter();

  useReveal();

  // Hero entrance animation
  useEffect(() => {
    const t = setTimeout(() => setHeroVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

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

  const handleBuild = useCallback(() => {
    sounds.build();
    const desc = input.trim();
    if (desc) {
      try { sessionStorage.setItem("aicos-build-desc", desc); } catch {}
    }
    const target = token ? "/companies/new" : "/login";
    router.push(desc ? `${target}?desc=${encodeURIComponent(desc)}` : target);
  }, [input, token, router]);

  return (
    <div style={{ minHeight: "100vh", background: "#0a0d14", color: "#e1e2eb", overflow: "hidden", position: "relative" }}>

      {/* Ambient gradient orbs */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
        <div className="animate-float-slow" style={{ position: "absolute", width: 800, height: 800, borderRadius: "50%", filter: "blur(160px)", opacity: 0.05, background: "radial-gradient(circle, #00d1ff, transparent)", top: -200, left: -100 }} />
        <div className="animate-float" style={{ position: "absolute", width: 600, height: 600, borderRadius: "50%", filter: "blur(140px)", opacity: 0.04, background: "radial-gradient(circle, #a855f7, transparent)", top: "40%", right: -200 }} />
        <div style={{ position: "absolute", width: 400, height: 400, borderRadius: "50%", filter: "blur(120px)", opacity: 0.03, background: "radial-gradient(circle, #00d1ff, transparent)", bottom: -100, left: "40%" }} />
      </div>

      {/* Top Nav */}
      <nav style={{
        position: "relative", zIndex: 20,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px clamp(16px, 4vw, 32px)",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        backdropFilter: "blur(12px)",
        background: "rgba(10,13,20,0.5)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Brand emblem — public/braavolabs-logo.png. CSS background
              fallback shows the gradient AI tile if the file is missing,
              so this works whether or not the asset has been dropped in. */}
          <div
            style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              boxShadow: "0 0 20px rgba(0,209,255,0.2)",
              backgroundColor: "#0a0d14",
              backgroundImage: "url(/braavolabs-logo.png), linear-gradient(135deg, #00d1ff, #6d11ad)",
              backgroundSize: "cover, cover",
              backgroundPosition: "center, center",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
            aria-label="Braavolabs"
            role="img"
          />
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15, color: "#e1e2eb", letterSpacing: "-0.02em" }}>Braavolabs</span>
        </div>

        <div className="hidden md:flex" style={{ alignItems: "center", gap: 28, fontSize: 13, fontWeight: 500 }}>
          {[["nav.features", "/features"], ["nav.pricing", "/pricing"], ["nav.docs", "/docs"]].map(([label, href]) => (
            <Link
              key={label}
              href={href}
              style={{ color: "#859399", textDecoration: "none", transition: "color 0.2s" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#a4e6ff"; sounds.hover(); }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#859399"; }}
            >
              {t(label)}
            </Link>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <LanguageSwitcher />
          {!token && (
            <Link href="/login" style={{ fontSize: 13, color: "#859399", textDecoration: "none", padding: "6px 14px", transition: "color 0.2s" }}
              onMouseEnter={(e) => e.currentTarget.style.color = "#e1e2eb"}
              onMouseLeave={(e) => e.currentTarget.style.color = "#859399"}
            >
              {t("nav.signIn")}
            </Link>
          )}
          <Link
            href="/dashboard"
            className="btn-primary"
            style={{ padding: "8px 18px", fontSize: 13, textDecoration: "none" }}
            onClick={() => sounds.click()}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>dashboard</span>
            {t("nav.dashboard")}
          </Link>
        </div>
      </nav>

      {/* ── SPLIT LAYOUT ── */}
      <div className="flex flex-col lg:flex-row" style={{ position: "relative", zIndex: 10, minHeight: "calc(100vh - 61px)" }}>

        {/* LEFT: Hero (75% on desktop, 100% on mobile) */}
        <div className="w-full lg:w-3/4" style={{ overflow: "hidden", position: "relative", minHeight: "calc(100vh - 61px)" }}>
          <AgentCanvas />

          {/* Hero content */}
          <div style={{
            position: "relative", zIndex: 2,
            height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            padding: "0 16px", paddingBottom: "6vh",
            opacity: heroVisible ? 1 : 0,
            transform: heroVisible ? "translateY(0)" : "translateY(20px)",
            transition: "opacity 0.8s cubic-bezier(0.16,1,0.3,1), transform 0.8s cubic-bezier(0.16,1,0.3,1)",
          }}>
            <div style={{ width: "100%", maxWidth: 600, textAlign: "center" }}>

              {/* Badge */}
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "5px 16px", borderRadius: 999,
                border: "1px solid rgba(0,209,255,0.2)",
                background: "rgba(0,209,255,0.05)",
                marginBottom: 28,
                opacity: heroVisible ? 1 : 0,
                transform: heroVisible ? "translateY(0)" : "translateY(10px)",
                transition: "all 0.8s cubic-bezier(0.16,1,0.3,1) 0.15s",
              }}>
                <span className="status-dot" style={{ background: "#00d1ff" }} />
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", color: "#a4e6ff" }}>BUILT FOR CREATORS & SOLO FOUNDERS</span>
              </div>

              {/* Headline */}
              <h1 style={{
                fontFamily: "'Space Grotesk', sans-serif", fontWeight: 800,
                fontSize: "clamp(2.4rem, 4.5vw, 4rem)", lineHeight: 1.05,
                letterSpacing: "-0.04em", marginBottom: 20,
                opacity: heroVisible ? 1 : 0,
                transform: heroVisible ? "translateY(0)" : "translateY(16px)",
                transition: "all 0.8s cubic-bezier(0.16,1,0.3,1) 0.2s",
              }}>
                <span style={{ color: "#e1e2eb" }}>Your AI company.</span><br />
                <span className="gradient-text">Built in 10 minutes.</span>
              </h1>

              <p style={{
                color: "#859399", fontSize: "1rem", lineHeight: 1.8,
                maxWidth: 520, margin: "0 auto 36px",
                opacity: heroVisible ? 1 : 0,
                transform: heroVisible ? "translateY(0)" : "translateY(12px)",
                transition: "all 0.8s cubic-bezier(0.16,1,0.3,1) 0.3s",
              }}>
                {t("hero.subtitle")}
              </p>

              {/* Builder Input */}
              <div
                className="animate-pulse-glow"
                style={{
                  width: "100%", borderRadius: 18, overflow: "hidden",
                  background: "rgba(15,18,25,0.85)",
                  border: "1px solid rgba(0,209,255,0.15)",
                  backdropFilter: "blur(20px)",
                  marginBottom: 16,
                  opacity: heroVisible ? 1 : 0,
                  transform: heroVisible ? "translateY(0)" : "translateY(10px)",
                  transition: "opacity 0.8s cubic-bezier(0.16,1,0.3,1) 0.35s, transform 0.8s cubic-bezier(0.16,1,0.3,1) 0.35s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 20px 6px" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 17, color: "#00d1ff" }}>smart_toy</span>
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", color: "#00d1ff" }}>AI COMPANY BUILDER</span>
                </div>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBuild(); }}
                  rows={3}
                  style={{
                    width: "100%", resize: "none", outline: "none", border: "none",
                    background: "transparent", color: "#e1e2eb",
                    padding: "6px 20px 10px", fontSize: 14, lineHeight: 1.7,
                    fontFamily: "inherit", boxSizing: "border-box",
                  }}
                  placeholder={displayText + (input ? "" : "▋")}
                />
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.04)",
                }}>
                  <span style={{ fontSize: 11, color: "#3c494e", display: "flex", alignItems: "center", gap: 4 }}>
                    <kbd style={{ padding: "2px 6px", borderRadius: 4, background: "rgba(255,255,255,0.06)", fontSize: 10, fontFamily: "inherit" }}>⌘</kbd>
                    <span>+</span>
                    <kbd style={{ padding: "2px 6px", borderRadius: 4, background: "rgba(255,255,255,0.06)", fontSize: 10, fontFamily: "inherit" }}>Enter</kbd>
                    <span style={{ marginLeft: 4 }}>to build</span>
                  </span>
                  <button
                    onClick={handleBuild}
                    className="btn-primary"
                    style={{ padding: "9px 22px", fontSize: 13 }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>rocket_launch</span>
                    Hire my AI team — free
                  </button>
                </div>
              </div>

              {/* Chips */}
              <div style={{
                display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, marginBottom: 32,
                opacity: heroVisible ? 1 : 0,
                transition: "opacity 0.8s 0.5s",
              }}>
                {["TikTok Content Studio", "Newsletter Growth", "Lead Follow-up", "Client Reporting"].map((chip) => (
                  <button
                    key={chip}
                    onClick={() => { setInput(`A ${chip.toLowerCase()} company that runs autonomously — I describe the goal, AI agents do the work, I review the output.`); sounds.click(); }}
                    style={{
                      padding: "5px 14px", borderRadius: 999, fontSize: 12, fontWeight: 500,
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      color: "#859399", cursor: "pointer",
                      transition: "all 0.25s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(0,209,255,0.25)"; e.currentTarget.style.color = "#a4e6ff"; e.currentTarget.style.background = "rgba(0,209,255,0.06)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#859399"; e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                  >
                    {chip}
                  </button>
                ))}
              </div>

              {/* Stats */}
              <div className="flex flex-wrap justify-center" style={{ gap: "16px 32px", opacity: heroVisible ? 1 : 0, transition: "opacity 0.8s 0.6s" }}>
                {[{ v: "10 min", l: t("stats.deploy") }, { v: "100%", l: t("stats.audited") }].map((s) => (
                  <div key={s.l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 14, color: "#e1e2eb" }}>{s.v}</span>
                    <span style={{ fontSize: 11, color: "#3c494e" }}>{s.l}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Dashboard side panel (25% on desktop, hidden on mobile) */}
        <div className="hidden lg:flex" style={{
          flex: "0 0 25%",
          background: "rgba(8,10,18,0.95)",
          borderLeft: "1px solid rgba(0,209,255,0.08)",
          flexDirection: "column",
          overflow: "hidden",
          backdropFilter: "blur(20px)",
        }}>
          {/* Panel header */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.04)", flexShrink: 0 }}>
            <span className="material-symbols-outlined" style={{ color: "#00d1ff", fontSize: 18 }}>dashboard</span>
            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 14, color: "#e1e2eb" }}>Dashboard</span>
          </div>

          {/* Panel body */}
          <div className="stagger-children" style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Metrics */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { label: "Agents", value: "9", icon: "smart_toy", color: "#00d1ff" },
                { label: "Uptime", value: "99.9%", icon: "check_circle", color: "#34d399" },
              ].map((m) => (
                <div key={m.label} className="metric-card" style={{ padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 13, color: m.color }}>{m.icon}</span>
                    <span style={{ fontSize: 10, color: "#859399" }}>{m.label}</span>
                  </div>
                  <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 20, color: "#e1e2eb" }}>{m.value}</span>
                </div>
              ))}
            </div>

            {/* Control Center */}
            <div className="glass-card" style={{ overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#e1e2eb", letterSpacing: "0.02em" }}>Control Center</span>
              </div>
              {[
                { icon: "business", label: "AI Companies", desc: "Create & manage", color: "#a4e6ff" },
                { icon: "account_tree", label: "Pipelines", desc: "Workflows & runs", color: "#34d399" },
                { icon: "task_alt", label: "Approvals", desc: "Spend reviews", color: "#fbbf24" },
                { icon: "query_stats", label: "Analytics", desc: "Performance data", color: "#c084fc" },
                { icon: "security", label: "Risk Shield", desc: "Governance", color: "#f87171" },
              ].map((item) => (
                <div
                  key={item.label}
                  className="interactive-row"
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: "default" }}
                >
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: `${item.color}10`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 14, color: item.color }}>{item.icon}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 11, fontWeight: 600, color: "#e1e2eb", margin: 0 }}>{item.label}</p>
                    <p style={{ fontSize: 9, color: "#3c494e", margin: 0 }}>{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Live activity */}
            <div className="glass-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span className="status-dot" style={{ background: "#34d399" }} />
                <span style={{ fontSize: 10, fontWeight: 600, color: "#34d399", letterSpacing: "0.1em" }}>LIVE</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {[
                  "Content published → TikTok",
                  "Lead scored → 0.92",
                  "Pipeline completed",
                ].map((msg, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 3, height: 3, borderRadius: "50%", background: "#3c494e", flexShrink: 0 }} />
                    <span style={{ fontSize: 10, color: "#859399" }}>{msg}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ flex: 1 }} />

            {/* CTA */}
            <Link
              href={token ? "/dashboard" : "/login"}
              className="btn-primary"
              style={{
                justifyContent: "center", padding: "14px 16px",
                borderRadius: 14, fontSize: 13, textDecoration: "none",
                width: "100%", boxSizing: "border-box",
              }}
              onClick={() => sounds.click()}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>login</span>
              {token ? "Enter Command Center" : "Sign In to Start"}
            </Link>
          </div>
        </div>
      </div>

      {/* Social proof / Trust section */}
      <section style={{ position: "relative", zIndex: 10, padding: "0 clamp(16px,4vw,32px) 28px" }}>
        {/* How it works */}
        <div className="stagger-children grid grid-cols-1 md:grid-cols-3" style={{ gap: 14, maxWidth: 840, margin: "0 auto 28px" }}>
          {[
            { n: "1", icon: "edit_note", title: "Describe", desc: "Tell Claude what your company does. Up to 3 clarification rounds." },
            { n: "2", icon: "auto_awesome", title: "AI Builds", desc: "Agents, pipelines, memory — all configured automatically." },
            { n: "3", icon: "trending_up", title: "Runs 24/7", desc: "Full audit log. You approve spend. Zero manual ops." },
          ].map((step) => (
            <div key={step.n} className="reveal glass-card" style={{ padding: 18 }}>
              <span style={{ position: "absolute", top: 10, right: 14, fontFamily: "'Space Grotesk',sans-serif", fontSize: 11, fontWeight: 700, color: "#3c494e" }}>{step.n}</span>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(0,209,255,0.06)", border: "1px solid rgba(0,209,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 17, color: "#00d1ff" }}>{step.icon}</span>
              </div>
              <p style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 13, color: "#e1e2eb", marginBottom: 4 }}>{step.title}</p>
              <p style={{ fontSize: 12, lineHeight: 1.6, color: "#859399" }}>{step.desc}</p>
            </div>
          ))}
        </div>

        {/* Trust badges */}
        <div className="reveal" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 36, flexWrap: "wrap" }}>
          {[
            { icon: "shield", text: "SOC 2 audit in progress — Q3 2026" },
            { icon: "lock", text: "AES-256 encrypted credentials" },
            { icon: "verified", text: "Full audit trail · every tool call" },
            { icon: "computer", text: "Self-hosted Gemma support · Creator+" },
          ].map((badge) => (
            <div key={badge.text} style={{ display: "flex", alignItems: "center", gap: 6, transition: "color 0.3s" }}
              onMouseEnter={(e) => e.currentTarget.style.color = "#a4e6ff"}
              onMouseLeave={(e) => e.currentTarget.style.color = "#3c494e"}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14, color: "inherit" }}>{badge.icon}</span>
              <span style={{ fontSize: 11, color: "inherit" }}>{badge.text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{ position: "relative", zIndex: 10, padding: "14px clamp(16px,4vw,32px)", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 16, height: 16, borderRadius: 3, background: "linear-gradient(135deg,#00d1ff,#6d11ad)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "white", fontWeight: 700, fontSize: 7 }}>AI</span>
            </div>
            <span style={{ fontSize: 11, color: "#3c494e" }}>Braavolabs</span>
            <span className="hidden sm:inline" style={{ fontSize: 10, color: "#3c494e", marginLeft: 8 }}>&copy; 2026 All rights reserved.</span>
          </div>
          <div className="hidden sm:flex" style={{ gap: 20, fontSize: 11 }}>
            {[["Features", "/features"], ["Pricing", "/pricing"], ["Docs", "/docs"], ["Privacy", "/privacy"], ["Terms", "/terms"]].map(([l, h]) => (
              <Link key={l} href={h} style={{ color: "#3c494e", textDecoration: "none", transition: "color 0.2s" }}
                onMouseEnter={(e) => e.currentTarget.style.color = "#859399"}
                onMouseLeave={(e) => e.currentTarget.style.color = "#3c494e"}
              >
                {l}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
