"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { PLAN_PRICING } from "@ai-company-os/core";
import { useAppStore } from "../lib/store";
import { sounds } from "../lib/sounds";
import { useReveal } from "../lib/useReveal";
import LanguageSwitcher from "../components/LanguageSwitcher";

// Landing pricing cards — names/desc/features come from the localized
// pricing.plans.* namespace; prices come from PLAN_PRICING (single source).
const LANDING_PLANS = [
  { id: "FREE",     key: "free",     featured: false },
  { id: "CREATOR",  key: "creator",  featured: false },
  { id: "PRO",      key: "pro",      featured: true  },
  { id: "BUSINESS", key: "business", featured: false },
] as const;

const EXAMPLES = [
  "A content agency that creates and schedules TikTok & LinkedIn posts for 10 clients",
  "An outbound sales team that qualifies leads and books demos automatically",
  "A customer success operation that monitors churn and sends personalized check-ins",
  "A finance back-office that reconciles invoices and generates weekly P&L reports",
];

// ── Forge stream fragments (hero pulse) ───────────────────────────────────────
const FRAGS = [
  "run.start › agent:acquisition › tool_call(search_market)…",
  'reasoning › "scanning 1,204 leads, ranking by ICP fit"…',
  'agent:sales › ask_user("approve $40 outreach budget?")…',
  'steer › "focus on EU mid-market only"…',
  "agent:delivery › compose_brief() › 3 drafts queued…",
  "spend $0.42 · step 12/18 · status ok",
];

// ── Audit trail data ──────────────────────────────────────────────────────────
const TRAIL = [
  { who: "agent:acquisition", txt: "Scanning the market for net-new ICP-fit accounts.", tool: 'search_market(region="EU", size="mid")', cost: "$0.06" },
  { who: "agent:acquisition", txt: "Ranked 412 candidates by fit score; shortlisting the top 50.", tool: 'rank_leads(by="icp_fit")', cost: "$0.04" },
  { who: "agent:sales",       txt: "Drafting tailored outreach for the shortlist.", tool: "compose_outreach(n=50)", cost: "$0.18" },
  { who: "agent:governance",  txt: "Spend gate: outreach send requires approval.", tool: "request_approval($30)", cost: "$0.00" },
  { who: "agent:delivery",    txt: "Approved. Sending and logging every dispatch to the audit trail.", tool: "send_batch(approved=true)", cost: "$0.14" },
];

// ── ask_user mini-scene ───────────────────────────────────────────────────────
const SCENE_SEQ = [
  { cls: "agent", who: "agent:sales", html: "I can reach 1,204 leads. Approve a $40 outreach budget to start the top 200?" },
  { cls: "user",  who: "",            html: "Yes — but EU mid-market only, cap at $30." },
  { cls: "agent", who: "agent:sales", html: "Understood. Narrowing to 412 EU mid-market leads, budget set to $30." },
  { cls: "resume",who: "",            html: "run resumed · step 13/18" },
];

// ── Providers marquee ─────────────────────────────────────────────────────────
const PROVIDERS = [
  "OpenAI","Anthropic","Google Gemini","Mistral","Cohere",
  "Groq","xAI","DeepSeek","Together","Fireworks","Ollama","Gemma · on-device",
];

// ── Governance chips ──────────────────────────────────────────────────────────
const GOV_CHIPS = [
  { dot: "bv-failed",  label: "hard-stop" },
  { dot: "bv-running", label: "loop-stop" },
  { dot: "bv-running", label: "cost-stop" },
  { dot: "bv-completed", label: "spam-stop" },
  { dot: "bv-failed",  label: "brand-stop" },
];

// ── Agent canvas (preserved exactly) ─────────────────────────────────────────
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
  [1,4],[4,6],[6,7],[4,5],
  [1,2],[2,4],[2,3],[3,9],
  [9,5],[5,8],[7,5],[6,4],
];

const MESSAGES = [
  "Lead scored → 0.87","Post scheduled → TikTok","Invoice reconciled",
  "Demo booked","Memory updated","Budget check → OK","Risk: none",
  "Content approved","CRM sync done","Video generated",
  "Image created → DALL-E","Pipeline completed",
];

function AgentCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);
  const particlesRef = useRef<any[]>([]);
  const messagesRef  = useRef<any[]>([]);
  const tickRef      = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width  = canvas.offsetWidth  * window.devicePixelRatio;
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
      const to   = AGENTS.find((a) => a.id === conn[1])!;
      particlesRef.current.push({
        fromX: from.x, fromY: from.y,
        toX: to.x,     toY: to.y,
        t: 0, speed: 0.003 + Math.random() * 0.004,
        color: Math.random() > 0.4 ? "#3B82F6" : "#60A5FA",
        size: 2 + Math.random() * 2,
      });
    };

    const spawnMessage = () => {
      const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
      const msg   = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
      messagesRef.current.push({ x: agent.x, y: agent.y, text: msg, alpha: 0, life: 0, maxLife: 160 });
    };

    const draw = () => {
      tickRef.current++;
      const w = W(), h = H();
      ctx.clearRect(0, 0, w, h);

      // Grid
      const gridAlpha = 0.02 + 0.01 * Math.sin(tickRef.current * 0.008);
      ctx.strokeStyle = `rgba(255,255,255,${gridAlpha})`;
      ctx.lineWidth = 0.5;
      for (let x = 0; x < w; x += 50) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
      for (let y = 0; y < h; y += 50) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }

      // Connections
      CONNECTIONS.forEach(([fromId, toId]) => {
        const from = AGENTS.find((a) => a.id === fromId)!;
        const to   = AGENTS.find((a) => a.id === toId)!;
        const grad = ctx.createLinearGradient(from.x*w, from.y*h, to.x*w, to.y*h);
        grad.addColorStop(0, "rgba(59,130,246,0.06)");
        grad.addColorStop(1, "rgba(37,99,235,0.04)");
        ctx.beginPath();
        ctx.moveTo(from.x*w, from.y*h);
        ctx.lineTo(to.x*w,   to.y*h);
        ctx.strokeStyle = grad;
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

        const prevT  = Math.max(0, p.t - 0.08);
        const prevX  = (p.fromX + (p.toX - p.fromX) * prevT) * w;
        const prevY  = (p.fromY + (p.toY - p.fromY) * prevT) * h;
        const trailG = ctx.createLinearGradient(prevX, prevY, px, py);
        const aHex   = Math.max(0, Math.min(255, Math.round(alpha * 140))).toString(16).padStart(2, "0");
        trailG.addColorStop(0, `${p.color}00`);
        trailG.addColorStop(1, `${p.color}${aHex}`);
        ctx.beginPath(); ctx.moveTo(prevX, prevY); ctx.lineTo(px, py);
        ctx.strokeStyle = trailG; ctx.lineWidth = p.size * 0.8; ctx.stroke();

        const cHex = Math.max(0, Math.min(255, Math.round(alpha * 220))).toString(16).padStart(2, "0");
        ctx.beginPath(); ctx.arc(px, py, p.size, 0, Math.PI*2);
        ctx.fillStyle = `${p.color}${cHex}`; ctx.fill();

        ctx.beginPath(); ctx.arc(px, py, p.size*3, 0, Math.PI*2);
        ctx.fillStyle = p.color + Math.round(alpha*20).toString(16).padStart(2,"0"); ctx.fill();
      });

      // Agent nodes
      AGENTS.forEach((agent) => {
        const ax    = agent.x * w;
        const ay    = agent.y * h;
        const pulse = 0.85 + 0.15 * Math.sin(tickRef.current * 0.03 + agent.id * 0.7);
        const brt   = 1 + 0.03 * Math.sin(tickRef.current * 0.02 + agent.id * 1.3);

        ctx.beginPath(); ctx.arc(ax, ay, 26*pulse, 0, Math.PI*2);
        const ringG = ctx.createRadialGradient(ax, ay, 12, ax, ay, 26*pulse);
        ringG.addColorStop(0, "rgba(59,130,246,0)");
        ringG.addColorStop(1, `rgba(59,130,246,${0.08*pulse})`);
        ctx.fillStyle = ringG; ctx.fill();

        ctx.beginPath(); ctx.arc(ax, ay, 17*brt, 0, Math.PI*2);
        ctx.fillStyle = "rgba(10,13,20,0.95)"; ctx.fill();
        ctx.strokeStyle = `rgba(59,130,246,${0.2 + 0.1*pulse})`; ctx.lineWidth = 1.5; ctx.stroke();

        ctx.font = "13px serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#E8EBF0"; ctx.fillText(agent.icon, ax, ay);

        ctx.font = "500 9px 'Space Grotesk', sans-serif";
        ctx.fillStyle = `rgba(96,165,250,${0.6 + 0.2*pulse})`;
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(agent.label, ax, ay + 22);
      });

      // Floating messages
      if (tickRef.current % 80 === 0) spawnMessage();
      messagesRef.current = messagesRef.current.filter((m) => m.life < m.maxLife);
      messagesRef.current.forEach((m) => {
        m.life++;
        m.alpha = m.life < 20 ? m.life/20 : m.life > 120 ? (m.maxLife - m.life)/40 : 1;
        const mx = m.x*w + 26;
        const my = m.y*h - 30 - (m.life*0.18);
        const tw = ctx.measureText(m.text).width + 20;
        roundRect(ctx, mx, my-11, tw, 22, 6);
        ctx.fillStyle = `rgba(10,13,20,${m.alpha*0.94})`; ctx.fill();
        ctx.strokeStyle = `rgba(59,130,246,${m.alpha*0.2})`; ctx.lineWidth = 0.5; ctx.stroke();
        ctx.font = "500 10px 'Space Grotesk', sans-serif";
        ctx.fillStyle = `rgba(96,165,250,${m.alpha*0.9})`;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(m.text, mx+10, my);
      });

      if (tickRef.current % 14 === 0) spawnParticle();
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(animRef.current); window.removeEventListener("resize", resize); };
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
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

// ── Ask-user mini-scene component ─────────────────────────────────────────────
function AskUserScene() {
  const [bubbles, setBubbles] = useState<typeof SCENE_SEQ>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const playingRef   = useRef(false);

  const playScene = useCallback(() => {
    if (playingRef.current) return;
    playingRef.current = true;
    setBubbles([]);
    let i = 0;
    const next = () => {
      if (i >= SCENE_SEQ.length) {
        setTimeout(() => { playingRef.current = false; playScene(); }, 2600);
        return;
      }
      const item = SCENE_SEQ[i++];
      setBubbles((prev) => [...prev, item]);
      setTimeout(next, item.cls === "resume" ? 1400 : 1500);
    };
    next();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { obs.disconnect(); playScene(); } }, { threshold: 0.3 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [playScene]);

  return (
    <div ref={containerRef} style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, justifyContent: "flex-end", minHeight: 150 }}>
      {bubbles.map((b, idx) => {
        if (b.cls === "resume") {
          return (
            <div key={idx} style={{ alignSelf: "center", display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontFamily: "var(--bv-font-mono)", color: "#FF7A1A", letterSpacing: "0.08em" }}>
              <span className="bv-dot bv-running bv-ping" />
              {b.html}
            </div>
          );
        }
        const isAgent = b.cls === "agent";
        return (
          <div key={idx} style={{
            alignSelf: isAgent ? "flex-start" : "flex-end",
            maxWidth: "80%",
            padding: "10px 14px",
            borderRadius: 14,
            fontSize: 13.5,
            lineHeight: 1.4,
            background: isAgent ? "rgba(20,23,31,0.9)" : "rgba(59,130,246,0.14)",
            border: isAgent ? "1px solid rgba(58,65,80,0.6)" : "1px solid rgba(96,165,250,0.3)",
            borderBottomLeftRadius: isAgent ? 4 : 14,
            borderBottomRightRadius: isAgent ? 14 : 4,
            color: "#E8EBF0",
            animation: "bv-stagger-fade 300ms var(--bv-ease-out) forwards",
          }}>
            {isAgent && <span style={{ display: "block", fontFamily: "var(--bv-font-mono)", fontSize: 10, letterSpacing: "0.1em", color: "#60A5FA", marginBottom: 3 }}>{b.who}</span>}
            {b.html}
          </div>
        );
      })}
    </div>
  );
}

// ── Audit trail component ─────────────────────────────────────────────────────
function AuditTrail() {
  const [visibleCount, setVisibleCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        obs.disconnect();
        TRAIL.forEach((_, i) => setTimeout(() => setVisibleCount(i + 1), i * 520));
      }
    }, { threshold: 0.2 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={containerRef} style={{ maxWidth: 760, marginTop: 46, display: "flex", flexDirection: "column" }}>
      {TRAIL.map((t, i) => (
        <div key={i} style={{
          display: "grid", gridTemplateColumns: "36px 1fr", gap: 18,
          paddingBottom: 18, position: "relative",
          opacity: visibleCount > i ? 1 : 0,
          transform: visibleCount > i ? "translateX(0)" : "translateX(-12px)",
          transition: "opacity 0.5s cubic-bezier(0.16,1,0.3,1), transform 0.5s cubic-bezier(0.16,1,0.3,1)",
        }}>
          {/* Rail */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#0B0D12", border: "2px solid #3B82F6", boxShadow: "0 0 12px #3B82F6", flexShrink: 0, marginTop: 4, zIndex: 2 }} />
            {i < TRAIL.length - 1 && (
              <div style={{
                flex: 1, width: 2, marginTop: 4,
                background: "linear-gradient(180deg,#3B82F6,rgba(59,130,246,0.15))",
                transformOrigin: "top",
                transform: visibleCount > i ? "scaleY(1)" : "scaleY(0)",
                transition: "transform 0.5s cubic-bezier(0.16,1,0.3,1) 0.2s",
              }} />
            )}
          </div>
          {/* Body */}
          <div style={{ paddingBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--bv-font-mono)", fontSize: 11, letterSpacing: "0.08em", color: "#60A5FA" }}>{t.who}</span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--bv-font-mono)", fontSize: 11.5, color: "#5B6473" }}>{t.cost}</span>
            </div>
            <p style={{ color: "#E8EBF0", fontSize: 14.5, marginTop: 6 }}>{t.txt}</p>
            <code style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, color: "#9AA3B2", background: "#0B0D12", border: "1px solid rgba(35,40,51,0.8)", borderRadius: 8, padding: "7px 11px", marginTop: 9, display: "inline-block" }}>{t.tool}</code>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Governance chips component ────────────────────────────────────────────────
function GovChips() {
  const [litCount, setLitCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        obs.disconnect();
        GOV_CHIPS.forEach((_, i) => setTimeout(() => setLitCount(i + 1), i * 240));
      }
    }, { threshold: 0.4 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginTop: 40 }}>
      {GOV_CHIPS.map((chip, i) => (
        <div key={chip.label} style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "12px 18px", borderRadius: 999,
          background: "#14171F",
          border: litCount > i ? "1px solid #3A4150" : "1px solid rgba(35,40,51,0.5)",
          fontFamily: "var(--bv-font-mono)", fontSize: 12.5,
          color: litCount > i ? "#E8EBF0" : "#5B6473",
          boxShadow: litCount > i ? "0 0 24px -8px #3B82F6" : "none",
          transition: "all 0.5s cubic-bezier(0.16,1,0.3,1)",
        }}>
          <span className={`bv-dot ${chip.dot}${chip.dot === "bv-running" ? " bv-ping" : ""}`} />
          {chip.label}
        </div>
      ))}
    </div>
  );
}

// ── Provider marquee component ────────────────────────────────────────────────
function ProviderMarquee() {
  const doubled = [...PROVIDERS, ...PROVIDERS];
  return (
    <div style={{ marginTop: 44, overflow: "hidden", maskImage: "linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)", WebkitMaskImage: "linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)" }}>
      <div style={{ display: "flex", gap: 14, width: "max-content", animation: "bv-marquee-scroll 32s linear infinite" }}>
        {doubled.map((p, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 22px", borderRadius: 12, background: "#14171F", border: "1px solid rgba(35,40,51,0.8)", fontFamily: "var(--bv-font-mono)", fontSize: 14, color: "#9AA3B2", whiteSpace: "nowrap" }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: "#3A4150", display: "inline-block" }} />
            {p}
          </div>
        ))}
      </div>
      <style>{`@keyframes bv-marquee-scroll{to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}

// ── Hero pulse stream ─────────────────────────────────────────────────────────
function HeroPulseStream() {
  const [fragIdx, setFragIdx] = useState(0);
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setOpacity(0);
      setTimeout(() => { setFragIdx((i) => (i + 1) % FRAGS.length); setOpacity(1); }, 220);
    }, 2600);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      maxWidth: 580, margin: "34px auto 0",
      fontFamily: "var(--bv-font-mono)", fontSize: 12.5, color: "#9AA3B2",
      background: "rgba(11,13,18,0.7)", border: "1px solid rgba(35,40,51,0.8)",
      borderRadius: 12, padding: "12px 16px",
      display: "flex", alignItems: "center", gap: 12,
      animation: "bv-stagger-fade 0.8s var(--bv-ease-out) 0.74s both",
    }}>
      <span className="bv-dot bv-running bv-ping" />
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity, transition: "opacity 0.22s ease" }}>{FRAGS[fragIdx]}</span>
      <span style={{ display: "inline-block", width: 8, height: 14, background: "#FF7A1A", animation: "bv-blink 1s steps(1) infinite" }} />
      <style>{`@keyframes bv-blink{50%{opacity:0}}`}</style>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const t = useTranslations();
  const locale = useLocale();
  const token = useAppStore((s) => s.token);
  const [input, setInput] = useState("");
  const [exampleIdx, setExampleIdx] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [charIdx, setCharIdx] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [heroVisible, setHeroVisible] = useState(false);
  const router = useRouter();

  useReveal();

  // Hero entrance
  useEffect(() => {
    const id = setTimeout(() => setHeroVisible(true), 100);
    return () => clearTimeout(id);
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
    if (desc) { try { sessionStorage.setItem("aicos-build-desc", desc); } catch {} }
    const target = token ? "/companies/new" : "/login";
    router.push(desc ? `${target}?desc=${encodeURIComponent(desc)}` : target);
  }, [input, token, router]);

  return (
    <div className="bv-mesh" style={{ minHeight: "100vh", color: "#E8EBF0", overflow: "hidden", position: "relative" }}>

      {/* ── NAV ── */}
      <nav id="nav" style={{
        position: "sticky", top: 0, zIndex: 40, height: 64,
        display: "flex", alignItems: "center",
        background: "rgba(11,13,18,0.72)", backdropFilter: "blur(18px) saturate(140%)",
        borderBottom: "1px solid rgba(35,40,51,0.8)",
      }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px", display: "flex", alignItems: "center", gap: 36, width: "100%" }}>
          {/* Lockup */}
          <Link href="#top" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none" }}>
            <div style={{
              width: 34, height: 34, borderRadius: "50%",
              background: "#0B0D12",
              backgroundImage: "url(/braavolabs-logo.png), linear-gradient(135deg,#3B82F6,#2563EB)",
              backgroundSize: "cover, cover", backgroundPosition: "center",
              WebkitMask: "radial-gradient(circle,#000 66%,transparent 74%)",
              mask: "radial-gradient(circle,#000 66%,transparent 74%)",
            }} aria-label="Braavolabs" role="img" />
            <span style={{ fontFamily: "var(--bv-font-display)", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase" as const, fontSize: 16, color: "#E8EBF0" }}>Braavolabs</span>
          </Link>

          {/* Nav links */}
          <div className="hidden md:flex" style={{ gap: 28, marginLeft: 8 }}>
            {(["Features","Pricing","Integrations","Changelog","Blog"] as const).map((label, i) => {
              const hrefs = ["#moat","#pricing","#providers","/changelog","/blog"];
              return (
                <a key={label} href={hrefs[i]} style={{ color: "#9AA3B2", textDecoration: "none", fontSize: 14.5, padding: "6px 0", transition: "color 0.3s" }}
                  onMouseEnter={(e) => e.currentTarget.style.color = "#E8EBF0"}
                  onMouseLeave={(e) => e.currentTarget.style.color = "#9AA3B2"}
                >{label}</a>
              );
            })}
          </div>

          {/* Nav right */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            <LanguageSwitcher />
            {!token && (
              <Link href="/login" className="btn-ghost" style={{ padding: "10px 16px", minHeight: 40, textDecoration: "none" }}>
                {t("nav.signIn")}
              </Link>
            )}
            <Link href="/dashboard" className="btn-primary" style={{ padding: "10px 18px", minHeight: 40, textDecoration: "none", fontSize: 13 }} onClick={() => sounds.click()}>
              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>dashboard</span>
              {t("nav.dashboard")}
            </Link>
          </div>
        </div>
      </nav>

      {/* ── HERO ── */}
      <header id="top" style={{
        position: "relative", minHeight: "100svh",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        textAlign: "center", padding: "80px 0 60px", overflow: "hidden",
      }}>
        {/* Background agent canvas */}
        <AgentCanvas />

        {/* Emblem */}
        <div id="emblem" style={{ position: "relative", width: "clamp(190px,26vw,300px)", aspectRatio: "1", marginBottom: 6, zIndex: 2 }}>
          <div style={{ position: "absolute", inset: "-18%", borderRadius: "50%", background: "radial-gradient(circle,rgba(59,130,246,.42) 0%,rgba(59,130,246,.12) 38%,transparent 68%)", filter: "blur(10px)", animation: "bv-halo 5s ease-in-out infinite" }} />
          <div style={{ position: "absolute", inset: "8%", bottom: "-6%", borderRadius: "50%", background: "radial-gradient(circle at 50% 80%,rgba(255,122,26,.16),transparent 60%)", filter: "blur(8px)", animation: "bv-halo 3.4s ease-in-out infinite" }} />
          <div style={{
            position: "relative", zIndex: 2, width: "100%", height: "100%",
            backgroundImage: "url(/braavolabs-logo.png), linear-gradient(135deg,#3B82F6,#2563EB)",
            backgroundSize: "cover, cover", backgroundPosition: "center",
            borderRadius: "50%",
            WebkitMask: "radial-gradient(circle,#000 70%,transparent 80%)",
            mask: "radial-gradient(circle,#000 70%,transparent 80%)",
            filter: "drop-shadow(0 12px 30px rgba(0,0,0,.7)) drop-shadow(0 0 26px rgba(59,130,246,.35))",
            animation: "bv-bob 7s ease-in-out infinite",
          }} role="img" aria-label="Braavolabs emblem" />
        </div>
        <style>{`
          @keyframes bv-halo{0%,100%{opacity:.7;transform:scale(1)}50%{opacity:1;transform:scale(1.05)}}
          @keyframes bv-bob{0%,100%{transform:translateY(0) rotate(-.6deg)}50%{transform:translateY(-10px) rotate(.6deg)}}
          @keyframes bv-rise{to{transform:translateY(0);opacity:1}}
        `}</style>

        {/* Kinetic headline */}
        <h1 style={{
          fontFamily: "var(--bv-font-display)", fontWeight: 600,
          fontSize: "clamp(34px,7vw,86px)", lineHeight: 0.92, letterSpacing: "-0.018em",
          textTransform: "uppercase" as const, marginTop: 18,
          position: "relative", zIndex: 2,
          opacity: heroVisible ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}>
          <span style={{ display: "block", overflow: "hidden", paddingBottom: "0.04em", whiteSpace: "nowrap" as const }}>
            <b style={{
              display: "inline-block", fontWeight: 600, lineHeight: 0.94,
              background: "linear-gradient(180deg,#fff 0%,#aab3c4 58%,#6b7587 100%)",
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
              animation: "bv-rise 0.85s cubic-bezier(0.22,1,0.36,1) 0.05s both",
            }}>Command the agents</b>
          </span>
          <span style={{ display: "block", overflow: "hidden", paddingBottom: "0.04em", whiteSpace: "nowrap" as const }}>
            <b style={{
              display: "inline-block", fontWeight: 600, lineHeight: 0.94,
              background: "linear-gradient(180deg,#fff 0%,#aab3c4 58%,#6b7587 100%)",
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
              animation: "bv-rise 0.85s cubic-bezier(0.22,1,0.36,1) 0.16s both",
            }}>
              you already{" "}
              <em style={{ fontStyle: "normal", background: "linear-gradient(180deg,#7DD3FC,#3B82F6)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>run.</em>
            </b>
          </span>
        </h1>

        {/* Sub */}
        <p style={{
          color: "#9AA3B2", fontSize: "clamp(16px,1.7vw,20px)", maxWidth: "58ch",
          margin: "26px auto 0", position: "relative", zIndex: 2,
          animation: "bv-stagger-fade 0.8s cubic-bezier(0.22,1,0.36,1) 0.5s both",
        }}>
          Build on the web. Steer &amp; approve from your pocket. Run fully offline. Bring your own keys across 12 providers — one war-room for every agent and automation you operate.
        </p>

        {/* CTA row */}
        <div style={{
          display: "flex", gap: 14, justifyContent: "center", marginTop: 32, flexWrap: "wrap",
          position: "relative", zIndex: 2,
          animation: "bv-stagger-fade 0.8s cubic-bezier(0.22,1,0.36,1) 0.62s both",
        }}>
          <button
            onClick={handleBuild}
            className="bv-btn bv-btn-primary"
            style={{ padding: "14px 24px", borderRadius: 999, fontSize: 15, minHeight: 48 }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>rocket_launch</span>
            Start free — no card needed
          </button>
          <a href="#trail" className="bv-btn bv-btn-ghost" style={{ padding: "14px 24px", borderRadius: 999, fontSize: 15, minHeight: 48 }}>
            Watch it steer
          </a>
        </div>

        {/* Typewriter builder box */}
        <div style={{
          maxWidth: 560, width: "100%", margin: "20px auto 0",
          position: "relative", zIndex: 2,
          animation: "bv-stagger-fade 0.8s cubic-bezier(0.22,1,0.36,1) 0.55s both",
        }}>
          <div className="bv-glass animate-pulse-glow" style={{ borderRadius: 18, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 20px 6px" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 17, color: "#60A5FA" }}>smart_toy</span>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", color: "#60A5FA", fontFamily: "var(--bv-font-mono)" }}>AI COMPANY BUILDER</span>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBuild(); }}
              rows={3}
              style={{
                width: "100%", resize: "none", outline: "none", border: "none",
                background: "transparent", color: "#E8EBF0",
                padding: "6px 20px 10px", fontSize: 14, lineHeight: 1.7,
                fontFamily: "inherit", boxSizing: "border-box" as const,
              }}
              placeholder={displayText + (input ? "" : "▋")}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <span style={{ fontSize: 11, color: "#5B6473", display: "flex", alignItems: "center", gap: 4 }}>
                <kbd style={{ padding: "2px 6px", borderRadius: 4, background: "rgba(255,255,255,0.06)", fontSize: 10, fontFamily: "inherit" }}>⌘</kbd>
                <span>+</span>
                <kbd style={{ padding: "2px 6px", borderRadius: 4, background: "rgba(255,255,255,0.06)", fontSize: 10, fontFamily: "inherit" }}>Enter</kbd>
                <span style={{ marginLeft: 4 }}>to build</span>
              </span>
              <button onClick={handleBuild} className="bv-btn bv-btn-primary bv-btn-sm">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>rocket_launch</span>
                Hire my AI team — free
              </button>
            </div>
          </div>
        </div>

        {/* Chips */}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 16, position: "relative", zIndex: 2, animation: "bv-stagger-fade 0.8s cubic-bezier(0.22,1,0.36,1) 0.65s both" }}>
          {["TikTok Content Studio","Newsletter Growth","Lead Follow-up","Client Reporting"].map((chip) => (
            <button key={chip} onClick={() => { setInput(`A ${chip.toLowerCase()} company that runs autonomously — I describe the goal, AI agents do the work, I review the output.`); sounds.click(); }}
              className="bv-fpill">
              {chip}
            </button>
          ))}
        </div>

        {/* Pulse stream */}
        <div style={{ position: "relative", zIndex: 2 }}>
          <HeroPulseStream />
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "16px 32px", marginTop: 20, position: "relative", zIndex: 2, animation: "bv-stagger-fade 0.8s cubic-bezier(0.22,1,0.36,1) 0.75s both" }}>
          {[{ v: "10 min", l: t("stats.deploy") }, { v: "100%", l: t("stats.audited") }].map((s) => (
            <div key={s.l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: "var(--bv-font-display)", fontWeight: 700, fontSize: 14, color: "#E8EBF0" }}>{s.v}</span>
              <span style={{ fontSize: 11, color: "#5B6473" }}>{s.l}</span>
            </div>
          ))}
        </div>

        {/* Scroll cue */}
        <div style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", fontFamily: "var(--bv-font-mono)", fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase" as const, color: "#5B6473", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, animation: "bv-stagger-fade 0.8s cubic-bezier(0.22,1,0.36,1) 1s both" }}>
          <span>Scroll</span>
          <span style={{ width: 1, height: 30, background: "linear-gradient(180deg,#3B82F6,transparent)", display: "block", animation: "bv-cue 2s cubic-bezier(0.22,1,0.36,1) infinite" }} />
          <style>{`@keyframes bv-cue{0%{transform:scaleY(0);transform-origin:top}50%{transform:scaleY(1);transform-origin:top}51%{transform:scaleY(1);transform-origin:bottom}100%{transform:scaleY(0);transform-origin:bottom}}`}</style>
        </div>
      </header>

      {/* ── MOAT ── */}
      <section id="moat" style={{ padding: "clamp(80px,9vw,128px) 0", position: "relative" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
          <div className="reveal" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, letterSpacing: "0.28em", textTransform: "uppercase" as const, color: "#60A5FA", display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 22, height: 1, background: "linear-gradient(90deg,transparent,#3B82F6)", display: "inline-block" }} />
            The moat
          </div>
          <h2 className="reveal" style={{ fontFamily: "var(--bv-font-display)", fontWeight: 600, fontSize: "clamp(30px,4.6vw,58px)", lineHeight: 0.98, letterSpacing: "-0.02em", textTransform: "uppercase" as const, margin: "16px 0 10px", color: "#E8EBF0" }}>
            Control, mobility &amp; privacy —<br />not connector count.
          </h2>
          <p className="reveal" style={{ color: "#9AA3B2", maxWidth: "62ch", fontSize: 17 }}>
            Five things no generic automation dashboard gives you. Each one locks into place like a forged steel plate.
          </p>

          {/* Moat grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12,1fr)", gap: 18, marginTop: 46 }}>

            {/* Feature card — mid-run steering */}
            <div id="moatScene" className="bv-glass reveal" style={{ padding: 28, gridColumn: "span 8", minHeight: 320, display: "flex", flexDirection: "column" }}>
              <span className="bv-pill bv-pill-amber" style={{ alignSelf: "flex-start" }}>The sharpest edge</span>
              <h3 style={{ fontFamily: "var(--bv-font-display)", fontSize: 23, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "-0.01em", margin: "18px 0 8px", color: "#E8EBF0" }}>Mid-run steering &amp; ask_user</h3>
              <p style={{ color: "#9AA3B2", fontSize: 14.5, maxWidth: "42ch" }}>Agents pause to ask. You answer — the run resumes, mid-flight. No re-runs, no babysitting.</p>
              <div style={{ marginTop: 18, background: "#0B0D12", border: "1px solid rgba(35,40,51,0.8)", borderRadius: 16, padding: 16, flex: 1, display: "flex", flexDirection: "column" }}>
                <AskUserScene />
              </div>
            </div>

            {/* Small moat cards */}
            {[
              { ix: "01", title: "Pocket-steer",            body: "Read, approve and redirect runs from your phone. Authoring stays on the web; control fits in your pocket." },
              { ix: "02", title: "BYOK · 12 providers",     body: "Bring your own keys and route across 12 providers — or go fully on-device with offline Gemma." },
              { ix: "03", title: "One dashboard",           body: "Unify n8n, Make and Zapier alongside native pipelines in a single audited war-room." },
              { ix: "04", title: "Flat, predictable price", body: "No per-connector tax, no surprise metering. One predictable price, every run accounted for." },
            ].map((card) => (
              <div key={card.ix} className="bv-glass reveal" style={{ padding: 28, gridColumn: "span 4", minHeight: 230, display: "flex", flexDirection: "column" }}>
                <span style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, color: "#5B6473", marginBottom: "auto" }}>{card.ix}</span>
                <h3 style={{ fontFamily: "var(--bv-font-display)", fontSize: 23, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "-0.01em", margin: "18px 0 8px", color: "#E8EBF0" }}>{card.title}</h3>
                <p style={{ color: "#9AA3B2", fontSize: 14.5, maxWidth: "42ch" }}>{card.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section id="how" style={{ padding: "clamp(80px,9vw,128px) 0", position: "relative" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
          <div className="reveal" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, letterSpacing: "0.28em", textTransform: "uppercase" as const, color: "#60A5FA", display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 22, height: 1, background: "linear-gradient(90deg,transparent,#3B82F6)", display: "inline-block" }} />
            How it works
          </div>
          <h2 className="reveal" style={{ fontFamily: "var(--bv-font-display)", fontWeight: 600, fontSize: "clamp(30px,4.6vw,58px)", lineHeight: 0.98, letterSpacing: "-0.02em", textTransform: "uppercase" as const, margin: "16px 0 10px", color: "#E8EBF0" }}>
            From idea to running team<br />in three steps.
          </h2>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 18, marginTop: 46 }}>
            {[
              { n: "1", title: "Describe",      body: "Tell Braavolabs what you want to automate in plain language. It asks a few sharp clarifying questions." },
              { n: "2", title: "Compose",       body: "Watch a multi-agent team spark into existence — acquisition, sales, delivery, ops — wired into a pipeline." },
              { n: "3", title: "Run & approve", body: "Launch with live SSE streaming. Approve every spend, steer mid-run, audit every tool call." },
            ].map((step) => (
              <div key={step.n} className="bv-glass reveal" style={{ padding: 28 }}>
                <span style={{ fontFamily: "var(--bv-font-display)", fontSize: 46, fontWeight: 600, lineHeight: 1, background: "linear-gradient(180deg,#60A5FA,#3B82F6)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>{step.n}</span>
                <h4 style={{ fontFamily: "var(--bv-font-display)", fontSize: 20, fontWeight: 600, textTransform: "uppercase" as const, margin: "14px 0 8px", color: "#E8EBF0" }}>{step.title}</h4>
                <p style={{ color: "#9AA3B2", fontSize: 14.5 }}>{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── GOVERNANCE ── */}
      <section id="gov" style={{ padding: "clamp(80px,9vw,128px) 0", textAlign: "center" as const, position: "relative" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
          <div className="reveal" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, letterSpacing: "0.28em", textTransform: "uppercase" as const, color: "#60A5FA", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <span style={{ width: 22, height: 1, background: "linear-gradient(90deg,transparent,#3B82F6)", display: "inline-block" }} />
            Governance
          </div>
          <p className="reveal" style={{ fontFamily: "var(--bv-font-display)", fontSize: "clamp(22px,3.2vw,38px)", fontWeight: 500, textTransform: "uppercase" as const, letterSpacing: "-0.01em", lineHeight: 1.18, maxWidth: "20ch", margin: "18px auto 0", color: "#E8EBF0" }}>
            Every tool call <span style={{ color: "#5B6473" }}>logged</span> · every spend <span style={{ color: "#5B6473" }}>approved</span> · every run <span style={{ color: "#5B6473" }}>audited</span>
          </p>
          <GovChips />
        </div>
      </section>

      {/* ── AUDIT TRAIL ── */}
      <section id="trail" style={{ padding: "clamp(80px,9vw,128px) 0", position: "relative" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
          <div className="reveal" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, letterSpacing: "0.28em", textTransform: "uppercase" as const, color: "#60A5FA", display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 22, height: 1, background: "linear-gradient(90deg,transparent,#3B82F6)", display: "inline-block" }} />
            Live audit trail
          </div>
          <h2 className="reveal" style={{ fontFamily: "var(--bv-font-display)", fontWeight: 600, fontSize: "clamp(30px,4.6vw,58px)", lineHeight: 0.98, letterSpacing: "-0.02em", textTransform: "uppercase" as const, margin: "16px 0 10px", color: "#E8EBF0" }}>
            Watch the run think.
          </h2>
          <p className="reveal" style={{ color: "#9AA3B2", maxWidth: "62ch", fontSize: 17 }}>
            Every step streams in real time — reasoning, tool calls and cost — connected by arc-light as the run forges forward.
          </p>
          <AuditTrail />
        </div>
      </section>

      {/* ── PROVIDERS + FLAGSHIP ── */}
      <section id="providers" style={{ padding: "clamp(80px,9vw,128px) 0", position: "relative" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
          <div className="reveal" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, letterSpacing: "0.28em", textTransform: "uppercase" as const, color: "#60A5FA", display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 22, height: 1, background: "linear-gradient(90deg,transparent,#3B82F6)", display: "inline-block" }} />
            Bring your own keys
          </div>
          <h2 className="reveal" style={{ fontFamily: "var(--bv-font-display)", fontWeight: 600, fontSize: "clamp(30px,4.6vw,58px)", lineHeight: 0.98, letterSpacing: "-0.02em", textTransform: "uppercase" as const, margin: "16px 0 10px", color: "#E8EBF0" }}>
            Twelve providers. One router.
          </h2>
        </div>
        <div className="reveal"><ProviderMarquee /></div>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
          <div className="bv-glass reveal" style={{ marginTop: 42, padding: 36, display: "flex", gap: 28, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <span className="bv-pill bv-pill-amber" style={{ marginBottom: 8 }}>Flagship template</span>
              <h3 style={{ fontFamily: "var(--bv-font-display)", fontSize: "clamp(24px,3vw,36px)", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "-0.01em", margin: "8px 0", color: "#E8EBF0" }}>The AI Company</h3>
              <p style={{ color: "#9AA3B2", maxWidth: "48ch", fontSize: 15 }}>Spin up a full nine-primitive agent company — acquisition, sales, delivery, content, ops, finance, analytics, memory and governance — from a single prompt.</p>
            </div>
            <button onClick={handleBuild} className="bv-btn bv-btn-primary" style={{ padding: "14px 28px", borderRadius: 999, fontSize: 15, minHeight: 48 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>construction</span>
              Forge the AI Company
            </button>
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section id="pricing" style={{ padding: "clamp(80px,9vw,128px) 0", position: "relative" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
          <div className="reveal" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, letterSpacing: "0.28em", textTransform: "uppercase" as const, color: "#60A5FA", display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 22, height: 1, background: "linear-gradient(90deg,transparent,#3B82F6)", display: "inline-block" }} />
            Pricing
          </div>
          <h2 className="reveal" style={{ fontFamily: "var(--bv-font-display)", fontWeight: 600, fontSize: "clamp(30px,4.6vw,58px)", lineHeight: 0.98, letterSpacing: "-0.02em", textTransform: "uppercase" as const, margin: "16px 0 10px", color: "#E8EBF0" }}>
            One flat price. No connector tax.
          </h2>
          <p className="reveal" style={{ color: "#9AA3B2", maxWidth: "62ch", fontSize: 17 }}>
            Start free with 10 runs a month — your first 3 runs use our hosted Groq pool, no API key needed. Scale on workspaces, connected automations and seats — never on connector count.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 18, marginTop: 46 }}>
            {LANDING_PLANS.map(({ id, key, featured }) => {
              const price = PLAN_PRICING[id]?.monthlyUsd ?? 0;
              const features = (t.raw(`pricing.plans.${key}.features`) as string[]).slice(0, 4);
              return (
                <div
                  key={id}
                  className="bv-glass reveal"
                  style={{
                    padding: 30,
                    display: "flex",
                    flexDirection: "column",
                    ...(featured ? { border: "1px solid #3B82F6" } : {}),
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <span style={{ fontFamily: "var(--bv-font-display)", fontSize: 22, fontWeight: 600, textTransform: "uppercase" as const, color: "#E8EBF0" }}>
                      {t(`pricing.plans.${key}.name`)}
                    </span>
                    {featured && (
                      <span style={{ fontFamily: "var(--bv-font-mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase" as const, color: "#60A5FA" }}>
                        {t("pricing.mostPopular")}
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: "var(--bv-font-display)", fontSize: 42, fontWeight: 600, margin: "16px 0 4px", color: "#E8EBF0" }}>
                    ${price}
                    <span style={{ fontSize: 15, color: "#9AA3B2", fontFamily: "inherit", fontWeight: 400 }}>
                      {" "}{price === 0 ? t("pricing.period.forever") : t("pricing.period.month")}
                    </span>
                  </div>
                  <p style={{ color: "#9AA3B2", fontSize: 14, minHeight: 40 }}>{t(`pricing.plans.${key}.desc`)}</p>
                  <ul style={{ listStyle: "none", margin: "20px 0 24px", display: "flex", flexDirection: "column", gap: 11, padding: 0 }}>
                    {features.map((item) => (
                      <li key={item} style={{ fontSize: 14, color: "#9AA3B2", display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <span style={{ width: 7, height: 7, borderRadius: 2, background: "#3B82F6", marginTop: 6, flexShrink: 0, boxShadow: "0 0 8px #3B82F6", display: "inline-block" }} />
                        {item}
                      </li>
                    ))}
                  </ul>
                  {id === "FREE" ? (
                    <Link href="/login" className="bv-btn bv-btn-primary" style={{ marginTop: "auto", width: "100%", justifyContent: "center", textDecoration: "none" }}>
                      {t(`pricing.plans.${key}.cta`)}
                    </Link>
                  ) : (
                    <Link href="/pricing" className={`bv-btn ${featured ? "bv-btn-primary" : "bv-btn-ghost"}`} style={{ marginTop: "auto", width: "100%", justifyContent: "center", textDecoration: "none" }}>
                      {t(`pricing.plans.${key}.cta`)}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>

          <p className="reveal" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 12, color: "#5B6473", marginTop: 20, textAlign: "center" as const }}>
            Paid plans bill as in-app subscriptions via the App Store / Google Play.
          </p>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section style={{ position: "relative", textAlign: "center" as const, padding: "clamp(100px,14vw,180px) 0", overflow: "hidden" }}>
        {/* Watermark emblem */}
        <div style={{
          position: "absolute", left: "50%", top: "46%", transform: "translate(-50%,-50%)",
          width: "min(640px,92vw)", aspectRatio: "1", opacity: 0.07, filter: "blur(1px)",
          pointerEvents: "none",
          backgroundImage: "url(/braavolabs-logo.png)",
          backgroundSize: "cover", backgroundPosition: "center",
          borderRadius: "50%",
          WebkitMask: "radial-gradient(circle,#000 60%,transparent 74%)",
          mask: "radial-gradient(circle,#000 60%,transparent 74%)",
        }} />
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px", position: "relative" }}>
          <h2 className="reveal" style={{ fontFamily: "var(--bv-font-display)", fontSize: "clamp(36px,7vw,92px)", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "-0.02em", lineHeight: 0.95, color: "#E8EBF0" }}>
            Forge your<br />workspace.
          </h2>
          <p className="reveal" style={{ color: "#9AA3B2", fontSize: 18, margin: "20px auto 0", maxWidth: "48ch" }}>
            The war-room for every agent you run. Build on the web, command from your pocket.
          </p>
          <div className="reveal" style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 36, flexWrap: "wrap" }}>
            <button onClick={handleBuild} className="bv-btn bv-btn-primary" style={{ padding: "14px 28px", borderRadius: 999, fontSize: 15, minHeight: 48 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>rocket_launch</span>
              Start free — no card needed
            </button>
            <a href="#trail" className="bv-btn bv-btn-ghost" style={{ padding: "14px 28px", borderRadius: 999, fontSize: 15, minHeight: 48 }}>
              Watch it steer
            </a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{ position: "relative", padding: "72px 0 40px", borderTop: "1px solid rgba(35,40,51,0.8)", overflow: "hidden" }}>
        {/* Sweeping arc line */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, left: "-30%", width: "30%", height: 1, background: "linear-gradient(90deg,transparent,#3B82F6,transparent)", animation: "bv-footsweep 6s linear infinite" }} />
          <style>{`@keyframes bv-footsweep{to{left:130%}}`}</style>
        </div>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 1fr", gap: 32 }}>
            {/* Brand col */}
            <div>
              <Link href="#top" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", marginBottom: 14 }}>
                <div style={{ width: 30, height: 30, borderRadius: "50%", background: "#0B0D12", backgroundImage: "url(/braavolabs-logo.png), linear-gradient(135deg,#3B82F6,#2563EB)", backgroundSize: "cover, cover", backgroundPosition: "center" }} />
                <span style={{ fontFamily: "var(--bv-font-display)", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase" as const, fontSize: 16, color: "#E8EBF0" }}>Braavolabs</span>
              </Link>
              <p style={{ color: "#9AA3B2", fontSize: 14, maxWidth: "34ch" }}>Command the AI agents &amp; automations you already run. Forged for control, mobility and privacy.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                {["EN","TR","ES","DE","FR","AR"].map((lang) => (
                  <button key={lang}
                    style={{ fontFamily: "var(--bv-font-mono)", fontSize: 11, textTransform: "uppercase" as const, color: locale === lang.toLowerCase() ? "#fff" : "#9AA3B2", background: "rgba(20,23,31,0.6)", border: `1px solid ${locale === lang.toLowerCase() ? "#3B82F6" : "rgba(35,40,51,0.8)"}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", transition: "all 0.25s" }}
                    onClick={() => {
                      const loc = lang.toLowerCase();
                      if (loc === locale) return;
                      document.cookie = `NEXT_LOCALE=${loc}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
                      window.location.reload();
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#fff"; e.currentTarget.style.borderColor = "#3B82F6"; }}
                    onMouseLeave={(e) => { if (locale !== lang.toLowerCase()) { e.currentTarget.style.color = "#9AA3B2"; e.currentTarget.style.borderColor = "rgba(35,40,51,0.8)"; } }}
                  >{lang}</button>
                ))}
              </div>
            </div>

            {/* Product */}
            <div>
              <h5 style={{ fontFamily: "var(--bv-font-mono)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase" as const, color: "#5B6473", marginBottom: 16 }}>Product</h5>
              {[["Features","#moat"],["Pricing","/pricing"],["Integrations","#providers"],["Changelog","/changelog"],["Blog","/blog"]].map(([l, h]) => (
                <a key={l} href={h} style={{ display: "block", color: "#9AA3B2", textDecoration: "none", fontSize: 14, padding: "5px 0", transition: "color 0.25s" }}
                  onMouseEnter={(e) => e.currentTarget.style.color = "#E8EBF0"}
                  onMouseLeave={(e) => e.currentTarget.style.color = "#9AA3B2"}
                >{l}</a>
              ))}
            </div>

            {/* Developers */}
            <div>
              <h5 style={{ fontFamily: "var(--bv-font-mono)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase" as const, color: "#5B6473", marginBottom: 16 }}>Developers</h5>
              {[["Webhooks","/webhooks"],["Status","/status"],["Support","/support"],["Changelog","/changelog"]].map(([l, h]) => (
                <Link key={l} href={h} style={{ display: "block", color: "#9AA3B2", textDecoration: "none", fontSize: 14, padding: "5px 0", transition: "color 0.25s" }}
                  onMouseEnter={(e) => e.currentTarget.style.color = "#E8EBF0"}
                  onMouseLeave={(e) => e.currentTarget.style.color = "#9AA3B2"}
                >{l}</Link>
              ))}
            </div>

            {/* Legal */}
            <div>
              <h5 style={{ fontFamily: "var(--bv-font-mono)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase" as const, color: "#5B6473", marginBottom: 16 }}>Legal</h5>
              {[["Privacy","/privacy"],["Terms","/terms"],["KVKK","/kvkk"],["GDPR","/gdpr"]].map(([l, h]) => (
                <Link key={l} href={h} style={{ display: "block", color: "#9AA3B2", textDecoration: "none", fontSize: 14, padding: "5px 0", transition: "color 0.25s" }}
                  onMouseEnter={(e) => e.currentTarget.style.color = "#E8EBF0"}
                  onMouseLeave={(e) => e.currentTarget.style.color = "#9AA3B2"}
                >{l}</Link>
              ))}
            </div>
          </div>

          {/* Bottom bar */}
          <div className="bv-divider" style={{ margin: "40px 0 20px" }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <span style={{ fontSize: 11, color: "#5B6473" }}>&copy; 2026 Braavolabs. All rights reserved.</span>
            <div style={{ display: "flex", gap: 20, fontSize: 11, flexWrap: "wrap" }}>
              {[["Delete Account","/legal/account-deletion"],["Cookies","/cookies"],["Contact","/contact"]].map(([l, h]) => (
                <Link key={l} href={h} style={{ color: "#5B6473", textDecoration: "none", transition: "color 0.2s" }}
                  onMouseEnter={(e) => e.currentTarget.style.color = "#9AA3B2"}
                  onMouseLeave={(e) => e.currentTarget.style.color = "#5B6473"}
                >{l}</Link>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
