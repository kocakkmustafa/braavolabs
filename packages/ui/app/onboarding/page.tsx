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

  if (!token) return <p className="text-gray-500">Please login first.</p>;

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
      // Refresh status
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
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Welcome to AI Company OS</h1>
      <p className="text-gray-500 mb-8">
        10 dakikada AI sirketini kur. Follow the steps below to get started.
      </p>

      {/* Progress */}
      {status && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Onboarding Progress</h2>
            <span className="text-sm text-blue-600 font-bold">
              {Math.round(status.progress * 100)}%
            </span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-3 mb-4">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all"
              style={{ width: `${status.progress * 100}%` }}
            />
          </div>
          <div className="space-y-2">
            {Object.entries(status.steps).map(([key, done]) => (
              <div key={key} className="flex items-center gap-3">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                  done ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"
                }`}>
                  {done ? "✓" : "○"}
                </span>
                <span className={done ? "text-gray-700" : "text-gray-400"}>
                  {stepLabels[key] ?? key}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hero Company Builder */}
      {!result && !status?.steps.heroCompanyCreated ? (
        <div className="bg-white rounded-lg shadow p-6 border-2 border-blue-200">
          <h2 className="text-lg font-semibold mb-2">Create Your Hero Company</h2>
          <p className="text-sm text-gray-500 mb-4">
            Your first AI company comes with a pre-configured content pipeline
            for TikTok and LinkedIn. Customize it below.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Company Name
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full border rounded-lg px-4 py-2"
                placeholder="My AI Social Agency"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Niche (optional)
              </label>
              <input
                type="text"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                className="w-full border rounded-lg px-4 py-2"
                placeholder="e.g. B2B SaaS, fitness, e-commerce..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Target Audience (optional)
              </label>
              <input
                type="text"
                value={targetAudience}
                onChange={(e) => setTargetAudience(e.target.value)}
                className="w-full border rounded-lg px-4 py-2"
                placeholder="e.g. startup founders, marketers, developers..."
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
                {error}
              </div>
            )}

            <button
              onClick={handleCreate}
              disabled={loading}
              className="w-full bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-semibold"
            >
              {loading ? "Creating your AI company..." : "Create Hero Company"}
            </button>
          </div>
        </div>
      ) : result ? (
        <div className="bg-green-50 border-2 border-green-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-green-800 mb-2">
            {result.company.name} created!
          </h2>
          <p className="text-sm text-green-700 mb-4">{result.company.description}</p>

          <div className="space-y-2 mb-4">
            <p className="text-sm text-green-600">
              <strong>{result.agents?.length ?? 0}</strong> agents configured
            </p>
            <p className="text-sm text-green-600">
              <strong>{result.pipeline?.name}</strong> pipeline ready
            </p>
          </div>

          <p className="text-sm text-green-700 font-medium">{result.nextStep}</p>

          <div className="flex gap-3 mt-4">
            <a
              href="/companies"
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 text-sm"
            >
              View Companies
            </a>
            <a
              href="/"
              className="bg-white text-green-700 border border-green-300 px-4 py-2 rounded-lg hover:bg-green-50 text-sm"
            >
              Go to Dashboard
            </a>
          </div>
        </div>
      ) : (
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
          <p className="text-green-700 font-medium">Hero company already created!</p>
          <div className="flex gap-3 mt-4 justify-center">
            <a href="/companies" className="text-blue-600 hover:text-blue-800 text-sm font-medium">
              View Companies
            </a>
            <a href="/" className="text-blue-600 hover:text-blue-800 text-sm font-medium">
              Dashboard
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
