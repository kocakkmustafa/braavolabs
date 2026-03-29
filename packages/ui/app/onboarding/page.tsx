"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

interface OnboardingStatus {
  completed: boolean;
  progress: number;
  steps: Record<string, boolean>;
}

const PRIMITIVES = [
  { id: "acquisition", label: "Acquisition", icon: "podcasts", desc: "Lead gen & growth" },
  { id: "sales", label: "Sales", icon: "work", desc: "Pipeline & deals" },
  { id: "delivery", label: "Delivery", icon: "deployed_code", desc: "Fulfillment ops" },
  { id: "content", label: "Content", icon: "edit_note", desc: "AI-generated content" },
  { id: "operations", label: "Operations", icon: "account_tree", desc: "Internal workflows" },
  { id: "finance", label: "Finance", icon: "payments", desc: "Revenue & billing" },
  { id: "analytics", label: "Analytics", icon: "query_stats", desc: "Insights & reports" },
  { id: "memory", label: "Memory", icon: "memory", desc: "Agent learning" },
  { id: "governance", label: "Governance", icon: "security", desc: "Risk & compliance" },
];

const STEP_LABELS = ["Company", "Primitives", "Channels", "Launch"];
const SUGGESTIONS = ["SaaS Startup", "Agency", "E-commerce", "Consulting", "Creator Business"];

export default function OnboardingPage() {
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [step, setStep] = useState(0);
  const [description, setDescription] = useState("");
  const [selectedPrimitives, setSelectedPrimitives] = useState<string[]>(["content", "acquisition"]);
  const [companyName, setCompanyName] = useState("My AI Social Agency");
  const [niche, setNiche] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.onboardingStatus(token).then(setStatus).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token) router.push("/login");
  }, [token, router]);

  if (!token) return null;

  function togglePrimitive(id: string) {
    setSelectedPrimitives((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  async function handleLaunch() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.createHeroCompany(token!, {
        companyName: companyName.trim() || undefined,
        niche: niche.trim() || undefined,
        targetAudience: targetAudience.trim() || undefined,
      });
      setResult(res);
      api.onboardingStatus(token!).then(setStatus).catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  const progressPct = status ? Math.round(status.progress * 100) : 0;

  // Already completed
  if (result || status?.steps?.heroCompanyCreated) {
    return (
      <div className="flex items-center justify-center min-h-screen px-6" style={{ background: "#0a0d14" }}>
        <div
          className="w-full max-w-[520px] glass-card rounded-2xl p-8 text-center"
          style={{ border: "1px solid rgba(52,211,153,0.2)" }}
        >
          <div
            className="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center"
            style={{ background: "rgba(52,211,153,0.1)" }}
          >
            <span className="material-symbols-outlined text-3xl" style={{ color: "#34d399" }}>
              check_circle
            </span>
          </div>
          <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
            {result?.company?.name ?? "Hero Company"} is live!
          </h2>
          <p className="text-sm mb-6" style={{ color: "#859399" }}>
            {result?.company?.description ?? "Your autonomous AI company is ready to run."}
          </p>
          {result && (
            <div className="flex justify-center gap-8 mb-6">
              <div>
                <p className="text-2xl font-bold font-headline" style={{ color: "#34d399" }}>
                  {result.agents?.length ?? 0}
                </p>
                <p className="text-xs" style={{ color: "#859399" }}>Agents</p>
              </div>
              <div>
                <p className="text-2xl font-bold font-headline" style={{ color: "#00d1ff" }}>1</p>
                <p className="text-xs" style={{ color: "#859399" }}>Pipeline</p>
              </div>
            </div>
          )}
          <div className="flex gap-3 justify-center">
            <Link
              href="/companies"
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
            >
              View Companies
            </Link>
            <Link
              href="/dashboard"
              className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}
            >
              Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex neural-mesh" style={{ background: "#0a0d14" }}>
      {/* Ambient bg */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 rounded-full opacity-[0.05] blur-3xl" style={{ background: "radial-gradient(circle, #00d1ff, transparent)" }} />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 rounded-full opacity-[0.05] blur-3xl" style={{ background: "radial-gradient(circle, #6d11ad, transparent)" }} />
        <div className="absolute inset-0 opacity-[0.02]" style={{ backgroundImage: "radial-gradient(circle, #ffffff 1px, transparent 1px)", backgroundSize: "32px 32px" }} />
      </div>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-12">
        {/* Header */}
        <div className="w-full max-w-[700px] mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
            >
              <span className="font-bold text-xs text-white">AI</span>
            </div>
            <span className="font-headline font-bold" style={{ color: "#e1e2eb" }}>AI Company OS</span>
          </div>

          {/* Progress steps */}
          <div className="flex items-center gap-2">
            {STEP_LABELS.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                    style={{
                      background: i < step ? "#00d1ff" : i === step ? "rgba(0,209,255,0.15)" : "rgba(255,255,255,0.04)",
                      border: i === step ? "1.5px solid #00d1ff" : i < step ? "none" : "1.5px solid rgba(255,255,255,0.08)",
                      color: i <= step ? (i < step ? "#0a0d14" : "#00d1ff") : "#3c494e",
                    }}
                  >
                    {i < step ? "✓" : i + 1}
                  </div>
                  <span
                    className="text-xs font-medium hidden sm:block"
                    style={{ color: i === step ? "#e1e2eb" : i < step ? "#bbc9cf" : "#3c494e" }}
                  >
                    {label}
                  </span>
                </div>
                {i < STEP_LABELS.length - 1 && (
                  <div className="w-8 h-px mx-1" style={{ background: i < step ? "#00d1ff" : "rgba(255,255,255,0.06)" }} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step card */}
        <div className="w-full max-w-[700px] glass-card rounded-2xl p-8 relative overflow-hidden">

          {/* Step 0: Company description */}
          {step === 0 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                Tell us about your company
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                Write in plain language — Claude will understand and build your agent stack automatically.
              </p>

              <div className="mb-4">
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Company Name</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all mb-4"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                  placeholder="My AI Social Agency"
                />
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Describe your business</label>
                <div className="relative">
                  <textarea
                    rows={5}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb", lineHeight: 1.7 }}
                    placeholder="e.g. I run a social media management agency for e-commerce brands. I need content creation, client reporting, and lead generation..."
                    onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                    onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                  />
                  <span className="absolute bottom-2 right-3 text-xs" style={{ color: "#3c494e" }}>{description.length} / 500</span>
                </div>
              </div>

              {/* Suggestions */}
              <div className="mb-6">
                <p className="text-xs mb-2" style={{ color: "#859399" }}>Need inspiration?</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setDescription(`I run a ${s.toLowerCase()} business. I need AI agents to handle acquisition, content creation, and operations.`)}
                      className="px-3 py-1.5 rounded-full text-xs font-medium transition-all hover:opacity-80"
                      style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.25)", color: "#00d1ff" }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => setStep(1)}
                  className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* Step 1: Primitives */}
          {step === 1 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                Select your AI Primitives
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                Choose which capabilities to include. You can change these later.
              </p>

              <div className="grid grid-cols-3 gap-3 mb-6">
                {PRIMITIVES.map((p) => {
                  const selected = selectedPrimitives.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePrimitive(p.id)}
                      className="p-4 rounded-xl text-left transition-all hover:scale-[1.02]"
                      style={{
                        background: selected ? "rgba(0,209,255,0.08)" : "rgba(255,255,255,0.03)",
                        border: selected ? "1.5px solid rgba(0,209,255,0.4)" : "1.5px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className="material-symbols-outlined text-lg"
                          style={{ color: selected ? "#00d1ff" : "#859399" }}
                        >
                          {p.icon}
                        </span>
                      </div>
                      <p className="text-sm font-semibold" style={{ color: selected ? "#e1e2eb" : "#bbc9cf" }}>{p.label}</p>
                      <p className="text-xs mt-0.5" style={{ color: "#859399" }}>{p.desc}</p>
                    </button>
                  );
                })}
              </div>

              <div className="flex justify-between">
                <button onClick={() => setStep(0)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  ← Back
                </button>
                <button onClick={() => setStep(2)} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}>
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Channels */}
          {step === 2 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                Configure your channels
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                Define your target audience and niche to personalize your agent outputs.
              </p>

              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Niche <span style={{ color: "#3c494e", fontWeight: 400 }}>(optional)</span></label>
                  <input
                    type="text"
                    value={niche}
                    onChange={(e) => setNiche(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                    placeholder="e.g. B2B SaaS, fitness, e-commerce..."
                    onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                    onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Target Audience <span style={{ color: "#3c494e", fontWeight: 400 }}>(optional)</span></label>
                  <input
                    type="text"
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                    placeholder="e.g. startup founders, marketers, developers..."
                    onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                    onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                  />
                </div>

                {/* Active channels */}
                <div>
                  <label className="block text-xs font-semibold mb-2" style={{ color: "#bbc9cf" }}>Active Channels (Free plan)</label>
                  <div className="flex gap-3">
                    {[
                      { name: "TikTok", icon: "🎵", included: true },
                      { name: "LinkedIn", icon: "💼", included: true },
                      { name: "Twitter/X", icon: "𝕏", included: false },
                      { name: "Instagram", icon: "📸", included: false },
                    ].map((ch) => (
                      <div key={ch.name} className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: ch.included ? "rgba(0,209,255,0.08)" : "rgba(255,255,255,0.03)", border: `1.5px solid ${ch.included ? "rgba(0,209,255,0.3)" : "rgba(255,255,255,0.05)"}`, opacity: ch.included ? 1 : 0.5 }}>
                        <span className="text-sm">{ch.icon}</span>
                        <span className="text-xs" style={{ color: ch.included ? "#bbc9cf" : "#3c494e" }}>{ch.name}</span>
                        {ch.included && <span className="text-[10px] font-semibold" style={{ color: "#00d1ff" }}>✓</span>}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs mt-2" style={{ color: "#3c494e" }}>Upgrade to Pro for all channels</p>
                </div>
              </div>

              <div className="flex justify-between">
                <button onClick={() => setStep(1)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  ← Back
                </button>
                <button onClick={() => setStep(3)} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}>
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Launch */}
          {step === 3 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                Ready to launch
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                Review your configuration and create your first autonomous AI company.
              </p>

              {/* Summary */}
              <div className="rounded-xl p-5 mb-5 space-y-3" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <SummaryRow label="Company Name" value={companyName || "My AI Social Agency"} />
                <SummaryRow label="Primitives" value={`${selectedPrimitives.length} selected`} highlight />
                <SummaryRow label="Channels" value="TikTok, LinkedIn" />
                {niche && <SummaryRow label="Niche" value={niche} />}
                {targetAudience && <SummaryRow label="Audience" value={targetAudience} />}
              </div>

              {error && (
                <div className="mb-4 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(255,180,171,0.08)", border: "1px solid rgba(255,180,171,0.2)", color: "#ffb4ab" }}>
                  {error}
                </div>
              )}

              <div className="flex justify-between">
                <button onClick={() => setStep(2)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  ← Back
                </button>
                <button
                  onClick={handleLaunch}
                  disabled={loading}
                  className="px-8 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 24px rgba(0,209,255,0.3)" }}
                >
                  {loading ? "Creating company..." : "Launch Company ✨"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Onboarding progress bar (if exists) */}
        {status && (
          <div
            className="w-full max-w-[700px] mt-5 glass-card rounded-xl p-4 flex items-center gap-4"
          >
            <div className="flex-1">
              <div className="flex justify-between mb-1">
                <span className="text-xs" style={{ color: "#859399" }}>Onboarding Progress</span>
                <span className="text-xs font-bold" style={{ color: "#00d1ff" }}>{progressPct}%</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${progressPct}%`, background: "linear-gradient(90deg, #00d1ff, #6d11ad)" }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm" style={{ color: "#859399" }}>{label}</span>
      <span className="text-sm font-semibold" style={{ color: highlight ? "#00d1ff" : "#bbc9cf" }}>{value}</span>
    </div>
  );
}
