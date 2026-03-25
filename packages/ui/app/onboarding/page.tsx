"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

interface OnboardingStatus {
  completed: boolean;
  progress: number;
  steps: Record<string, boolean>;
}

export default function OnboardingPage() {
  const token = useAppStore((s) => s.token);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
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

  if (!token) return <p className="text-slate-500 p-8">Please login first.</p>;

  async function handleCreate() {
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

  const stepLabels: Record<string, string> = {
    accountCreated: "Account Created",
    heroCompanyCreated: "Hero Company Created",
    firstPipelineRun: "First Pipeline Run",
    firstDraftCreated: "First Draft Created",
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-100">Welcome to AI Company OS</h1>
        <p className="text-slate-500 mt-1">
          Set up your AI company in 10 minutes. Follow the steps below to get started.
        </p>
      </div>

      {/* Progress */}
      {status && (
        <div className="card-glass p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-slate-200">Onboarding Progress</h2>
            <span className="text-sm text-brand-400 font-bold">
              {Math.round(status.progress * 100)}%
            </span>
          </div>
          <div className="w-full bg-white/[0.06] rounded-full h-2 mb-4">
            <div
              className="gradient-brand h-2 rounded-full transition-all"
              style={{ width: `${status.progress * 100}%` }}
            />
          </div>
          <div className="space-y-2">
            {Object.entries(status.steps).map(([key, done]) => (
              <div key={key} className="flex items-center gap-3">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs border ${
                  done
                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                    : "bg-white/[0.04] text-slate-600 border-white/[0.08]"
                }`}>
                  {done ? "✓" : "○"}
                </span>
                <span className={done ? "text-slate-300" : "text-slate-600"}>
                  {stepLabels[key] ?? key}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hero Company Builder */}
      {!result && !status?.steps.heroCompanyCreated ? (
        <div className="card-glass p-6 border border-brand-500/20">
          <h2 className="text-lg font-semibold text-slate-200 mb-2">Create Your Hero Company</h2>
          <p className="text-sm text-slate-500 mb-4">
            Your first AI company comes with a pre-configured content pipeline
            for TikTok and LinkedIn. Customize it below.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">
                Company Name
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500/50 outline-none transition-all"
                placeholder="My AI Social Agency"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">
                Niche <span className="text-slate-600 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-brand-500/50 outline-none transition-all"
                placeholder="e.g. B2B SaaS, fitness, e-commerce..."
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">
                Target Audience <span className="text-slate-600 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={targetAudience}
                onChange={(e) => setTargetAudience(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-brand-500/50 outline-none transition-all"
                placeholder="e.g. startup founders, marketers, developers..."
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm">
                {error}
              </div>
            )}

            <button
              onClick={handleCreate}
              disabled={loading}
              className="w-full gradient-brand text-white px-6 py-3 rounded-xl hover:shadow-lg hover:shadow-brand-500/20 disabled:opacity-50 font-semibold transition-all"
            >
              {loading ? "Creating your AI company..." : "Create Hero Company"}
            </button>
          </div>
        </div>
      ) : result ? (
        <div className="card-glass border border-emerald-500/20 p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
            </div>
            <h2 className="text-lg font-semibold text-slate-200">
              {result.company.name} created!
            </h2>
          </div>
          <p className="text-sm text-slate-400 mb-4">{result.company.description}</p>

          <div className="space-y-1 mb-4">
            <p className="text-sm text-slate-300">
              <span className="text-emerald-400 font-semibold">{result.agents?.length ?? 0}</span> agents configured
            </p>
            <p className="text-sm text-slate-300">
              <span className="text-brand-400 font-semibold">{result.pipeline?.name}</span> pipeline ready
            </p>
          </div>

          <p className="text-sm text-slate-400 font-medium mb-4">{result.nextStep}</p>

          <div className="flex gap-3">
            <a
              href="/companies"
              className="gradient-brand text-white px-4 py-2 rounded-xl text-sm font-semibold hover:shadow-lg hover:shadow-brand-500/20 transition-all"
            >
              View Companies
            </a>
            <a
              href="/"
              className="bg-white/[0.06] text-slate-300 border border-white/[0.08] px-4 py-2 rounded-xl text-sm font-semibold hover:bg-white/[0.08] transition-colors"
            >
              Go to Dashboard
            </a>
          </div>
        </div>
      ) : (
        <div className="card-glass border border-emerald-500/20 p-6 text-center">
          <p className="text-emerald-400 font-medium">Hero company already created!</p>
          <div className="flex gap-3 mt-4 justify-center">
            <a href="/companies" className="text-brand-400 hover:text-brand-300 text-sm font-medium transition-colors">
              View Companies
            </a>
            <a href="/" className="text-brand-400 hover:text-brand-300 text-sm font-medium transition-colors">
              Dashboard
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
