"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../lib/store";
import { useRouter } from "next/navigation";

export default function LandingPage() {
  const token = useAppStore((s) => s.token);
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const heroRef = useRef<HTMLDivElement>(null);

  const placeholder = "Describe your company's mission...";

  // Typewriter effect for placeholder
  useEffect(() => {
    let i = 0;
    let forward = true;
    const interval = setInterval(() => {
      if (forward) {
        i++;
        if (i >= placeholder.length) { forward = false; setTimeout(() => {}, 1200); }
      } else {
        i--;
        if (i <= 0) forward = true;
      }
      setTyped(placeholder.slice(0, i));
    }, 60);
    return () => clearInterval(interval);
  }, []);

  // Mouse parallax
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      setMousePos({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight });
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  return (
    <div className="min-h-screen bg-[#0d0f18] text-white overflow-x-hidden">
      {/* ── Ambient background ────────────────────────────────── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        {/* Top-left cyan orb */}
        <div
          className="absolute w-[600px] h-[600px] rounded-full opacity-[0.07] blur-[120px]"
          style={{
            background: "radial-gradient(circle, #00d4ff, transparent)",
            top: "-100px",
            left: "-100px",
            transform: `translate(${mousePos.x * 20}px, ${mousePos.y * 20}px)`,
            transition: "transform 0.8s ease-out",
          }}
        />
        {/* Center purple orb */}
        <div
          className="absolute w-[800px] h-[800px] rounded-full opacity-[0.06] blur-[140px]"
          style={{
            background: "radial-gradient(circle, #7c3aed, transparent)",
            top: "20%",
            left: "30%",
            transform: `translate(${mousePos.x * -15}px, ${mousePos.y * -15}px)`,
            transition: "transform 1s ease-out",
          }}
        />
        {/* Bottom-right cyan */}
        <div
          className="absolute w-[500px] h-[500px] rounded-full opacity-[0.05] blur-[100px]"
          style={{
            background: "radial-gradient(circle, #06b6d4, transparent)",
            bottom: "0",
            right: "0",
          }}
        />
        {/* Dot grid */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: "radial-gradient(circle, #ffffff 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />
      </div>

      {/* ── Navigation ────────────────────────────────────────── */}
      <nav className="relative z-50 flex items-center justify-between px-8 py-4 border-b border-white/[0.06] backdrop-blur-md bg-[#0d0f18]/80">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, #6366f1, #00d4ff)" }}>
            <span className="text-white font-bold text-sm">AI</span>
          </div>
          <span className="font-bold text-base tracking-tight text-white">AI Company OS</span>
        </div>

        {/* Nav links */}
        <div className="hidden md:flex items-center gap-1">
          {["Builder", "Dashboard", "Registry", "Analytics"].map((item, i) => (
            <a
              key={item}
              href={item === "Dashboard" ? (token ? "/dashboard" : "/login") : item === "Builder" ? "/companies/new" : "#"}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                i === 0
                  ? "text-white bg-white/[0.08] border border-white/[0.12]"
                  : "text-slate-400 hover:text-white hover:bg-white/[0.05]"
              }`}
            >
              {item}
            </a>
          ))}
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5">
            <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
            <span className="text-xs text-slate-500">Search systems...</span>
          </div>
          {token ? (
            <a href="/dashboard" className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: "linear-gradient(135deg, #6366f1, #00d4ff)" }}>
              Dashboard →
            </a>
          ) : (
            <>
              <a href="/login" className="text-sm text-slate-400 hover:text-white transition-colors px-3 py-1.5">Sign in</a>
              <a href="/login" className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: "linear-gradient(135deg, #6366f1, #00d4ff)" }}>
                Get Started
              </a>
            </>
          )}
        </div>
      </nav>

      {/* ── Hero Section ──────────────────────────────────────── */}
      <section ref={heroRef} className="relative z-10 px-8 pt-12 pb-8 max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
          {/* Left column */}
          <div>
            {/* Status badge */}
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
              <span className="text-xs font-semibold text-cyan-400 tracking-widest uppercase">Platform Active</span>
            </div>

            {/* Headline */}
            <h1 className="text-5xl font-black leading-tight mb-4">
              <span className="text-white">Autonomous</span>
              <br />
              <span style={{ background: "linear-gradient(135deg, #00d4ff, #7c3aed)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                AI Companies
              </span>
            </h1>

            <p className="text-slate-400 text-base leading-relaxed mb-8 max-w-md">
              Build, deploy, and scale autonomous AI-powered companies from a single platform.
              Describe your vision — we handle agents, pipelines, and execution.
            </p>

            {/* Input area */}
            <div className="relative mb-4">
              <div className="absolute inset-0 rounded-xl blur-sm opacity-30" style={{ background: "linear-gradient(135deg, #6366f1, #00d4ff)" }} />
              <div className="relative bg-[#141620] border border-white/[0.10] rounded-xl p-4">
                <textarea
                  rows={4}
                  className="w-full bg-transparent text-slate-300 text-sm resize-none outline-none placeholder-slate-600"
                  placeholder={typed + "▋"}
                />
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-3 flex-wrap">
              <button className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" /></svg>
                LINK KNOWLEDGE BASE
              </button>
              <button className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" /></svg>
                SAFETY FILTERS
              </button>
              <a
                href={token ? "/companies/new" : "/login"}
                className="ml-auto px-6 py-2.5 rounded-xl text-sm font-bold text-[#0d0f18] transition-all hover:scale-105 hover:shadow-lg"
                style={{ background: "linear-gradient(135deg, #00d4ff, #7c3aed)", boxShadow: "0 0 24px rgba(0, 212, 255, 0.3)" }}
              >
                BUILD COMPANY
              </a>
            </div>
          </div>

          {/* Right column — HUD Panel */}
          <div className="flex flex-col gap-4">
            {/* Main HUD card */}
            <div className="relative rounded-2xl overflow-hidden border border-white/[0.08]" style={{ background: "linear-gradient(135deg, #141926 0%, #0d1420 100%)" }}>
              {/* Glow center */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-48 h-48 rounded-full opacity-20 blur-3xl" style={{ background: "radial-gradient(circle, #00d4ff, transparent)" }} />
              </div>

              <div className="relative p-8 flex flex-col items-center justify-center min-h-[220px]">
                {/* AI brain icon */}
                <div className="w-24 h-24 rounded-2xl flex items-center justify-center mb-4 border border-white/[0.08]" style={{ background: "rgba(0,212,255,0.08)" }}>
                  <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="url(#grad1)" strokeWidth={1.2}>
                    <defs>
                      <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#00d4ff" />
                        <stop offset="100%" stopColor="#7c3aed" />
                      </linearGradient>
                    </defs>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
                  </svg>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-2 gap-6 w-full mt-2">
                  <div>
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">Active Agents</p>
                    <AnimatedNumber value={42} suffix="k/s" className="text-2xl font-black text-white" />
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">Success Rate</p>
                    <AnimatedNumber value={99.9} suffix="%" className="text-2xl font-black" style={{ color: "#00d4ff" }} />
                  </div>
                </div>
              </div>

              {/* Config HUD footer */}
              <div className="border-t border-white/[0.06] px-6 py-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                    <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Configuration HUD</span>
                  </div>
                  <span className="text-[10px] font-mono text-cyan-400 border border-cyan-400/30 px-2 py-0.5 rounded">v2.4.0_STABLE</span>
                </div>
                <HudBar label="Pipeline Depth" value={70} color="#00d4ff" note="Level 07" />
                <HudBar label="Token Efficiency" value={82} color="#7c3aed" note="0.82 High" />
                <div className="mt-3 font-mono text-[10px] text-slate-600">
                  <span className="text-slate-500">[SYS]</span> Awaiting company initialization...
                  <span className="inline-block w-1.5 h-3 bg-cyan-400 ml-1 animate-pulse" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Agent Cards ───────────────────────────────────────── */}
      <section className="relative z-10 px-8 py-8 max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            {
              icon: "📈",
              name: "Market Sentinel",
              desc: "Autonomous PR & acquisition engine. Scans market signals and executes growth strategies.",
              color: "#6366f1",
            },
            {
              icon: "⚡",
              name: "Nexus Dev",
              desc: "Neural branding and viral content generation. Deploys to TikTok, LinkedIn, and beyond.",
              color: "#00d4ff",
            },
            {
              icon: "✨",
              name: "Ghost Writer",
              desc: "AI copywriting agent. Produces high-converting ad copy, emails, and blog posts at scale.",
              color: "#7c3aed",
            },
          ].map((agent) => (
            <div
              key={agent.name}
              className="group relative rounded-2xl p-5 border border-white/[0.07] cursor-pointer transition-all duration-300 hover:border-white/[0.15] hover:scale-[1.02]"
              style={{ background: "linear-gradient(135deg, #141926 0%, #0d1118 100%)" }}
            >
              <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-xl" style={{ background: `radial-gradient(circle at center, ${agent.color}18, transparent)` }} />
              <div className="relative">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 text-xl" style={{ background: `${agent.color}18`, border: `1px solid ${agent.color}30` }}>
                  {agent.icon}
                </div>
                <h3 className="font-bold text-white mb-1">{agent.name}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{agent.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features Grid ─────────────────────────────────────── */}
      <section className="relative z-10 px-8 py-16 max-w-[1200px] mx-auto">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-violet-500/30 bg-violet-500/10 mb-4">
            <span className="text-xs font-semibold text-violet-400 tracking-widest uppercase">Core Systems</span>
          </div>
          <h2 className="text-4xl font-black text-white mb-3">
            Everything your AI company<br />
            <span style={{ background: "linear-gradient(135deg, #00d4ff, #7c3aed)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>needs to operate</span>
          </h2>
          <p className="text-slate-400 max-w-lg mx-auto">29 built-in tools, autonomous agent loops, and full governance — all in one platform.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { icon: "🤖", title: "Autonomous Agents", desc: "Claude-powered agents with tool use, retry logic, and budget controls. Every decision logged.", color: "#6366f1" },
            { icon: "🧠", title: "Memory Engine", desc: "Episodic + semantic + graph memory. Agents learn from every run and improve over time.", color: "#00d4ff" },
            { icon: "⚙️", title: "Pipeline Runner", desc: "Multi-step workflows with cron scheduling and BullMQ-powered queue management.", color: "#7c3aed" },
            { icon: "🛡️", title: "Governance Engine", desc: "Cost anomaly detection, loop prevention, spam protection, and brand safety filters.", color: "#ec4899" },
            { icon: "📊", title: "Analytics & CRM", desc: "HubSpot integration, deal tracking, and real-time usage metrics across all companies.", color: "#f59e0b" },
            { icon: "💳", title: "Usage Billing", desc: "Stripe-powered metering. Free tier included. Scale from $0 to enterprise on demand.", color: "#10b981" },
          ].map((f) => (
            <div
              key={f.title}
              className="group p-5 rounded-2xl border border-white/[0.06] hover:border-white/[0.12] transition-all duration-300"
              style={{ background: "rgba(255,255,255,0.02)" }}
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 text-xl" style={{ background: `${f.color}15`, border: `1px solid ${f.color}25` }}>
                {f.icon}
              </div>
              <h3 className="font-bold text-white text-sm mb-1.5">{f.title}</h3>
              <p className="text-xs text-slate-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Stats Banner ──────────────────────────────────────── */}
      <section className="relative z-10 px-8 py-12 max-w-[1200px] mx-auto">
        <div className="relative rounded-2xl border border-white/[0.08] overflow-hidden p-10" style={{ background: "linear-gradient(135deg, #141926, #0d1118)" }}>
          <div className="absolute inset-0 opacity-10" style={{ background: "radial-gradient(ellipse at center, #00d4ff, transparent 70%)" }} />
          <div className="relative grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            {[
              { value: "29", label: "Built-in Tools" },
              { value: "9", label: "Primitives" },
              { value: "10m", label: "To First Company" },
              { value: "100%", label: "Audited Actions" },
            ].map((s) => (
              <div key={s.label}>
                <p className="text-4xl font-black mb-1" style={{ background: "linear-gradient(135deg, #00d4ff, #7c3aed)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>{s.value}</p>
                <p className="text-xs text-slate-500 uppercase tracking-widest">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Section ───────────────────────────────────────── */}
      <section className="relative z-10 px-8 py-20 max-w-[800px] mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-xs font-semibold text-cyan-400 tracking-widest uppercase">Free to start</span>
        </div>
        <h2 className="text-5xl font-black text-white mb-4">
          Launch your AI company<br />
          <span style={{ background: "linear-gradient(135deg, #00d4ff, #7c3aed)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>in 10 minutes</span>
        </h2>
        <p className="text-slate-400 mb-10 max-w-md mx-auto">No credit card required. Start with the Free plan — 1 company, 10 runs/month, real AI outputs.</p>
        <div className="flex items-center justify-center gap-4">
          <a
            href="/login"
            className="px-8 py-3.5 rounded-xl font-bold text-[#0d0f18] text-sm transition-all hover:scale-105 hover:shadow-2xl"
            style={{ background: "linear-gradient(135deg, #00d4ff, #7c3aed)", boxShadow: "0 0 40px rgba(0, 212, 255, 0.25)" }}
          >
            Start Building Free
          </a>
          <a href="#features" className="px-8 py-3.5 rounded-xl font-semibold text-slate-300 text-sm border border-white/[0.10] hover:bg-white/[0.05] transition-colors">
            Learn More
          </a>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-white/[0.06] px-8 py-8">
        <div className="max-w-[1200px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: "linear-gradient(135deg, #6366f1, #00d4ff)" }}>
              <span className="text-white font-bold text-[10px]">AI</span>
            </div>
            <span className="text-sm text-slate-500">AI Company OS</span>
          </div>
          <p className="text-xs text-slate-600">Built with Claude by <a href="https://github.com/kocakkmustafa" className="text-slate-500 hover:text-white transition-colors">@kocakkmustafa</a></p>
        </div>
      </footer>
    </div>
  );
}

/* ─── Helper Components ───────────────────────────────────── */

function AnimatedNumber({ value, suffix, className, style }: { value: number; suffix: string; className?: string; style?: React.CSSProperties }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let start = 0;
    const end = value;
    const step = end / 40;
    const timer = setInterval(() => {
      start += step;
      if (start >= end) { setDisplay(end); clearInterval(timer); return; }
      setDisplay(parseFloat(start.toFixed(1)));
    }, 30);
    return () => clearInterval(timer);
  }, [value]);
  return <span className={className} style={style}>{display}{suffix}</span>;
}

function HudBar({ label, value, color, note }: { label: string; value: number; color: string; note: string }) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    setTimeout(() => setWidth(value), 300);
  }, [value]);
  return (
    <div className="mb-2">
      <div className="flex justify-between items-center mb-1">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
        <span className="text-[10px] font-mono" style={{ color }}>{note}</span>
      </div>
      <div className="h-1 bg-white/[0.05] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-1000 ease-out"
          style={{ width: `${width}%`, background: `linear-gradient(90deg, ${color}, ${color}88)` }}
        />
      </div>
    </div>
  );
}
