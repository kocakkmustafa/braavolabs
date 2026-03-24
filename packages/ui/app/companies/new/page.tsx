"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../lib/store";

type WizardStep = "describe" | "clarify" | "preview" | "creating" | "done";

interface BuildSession {
  sessionId: string;
  status: string;
  turn: number;
  companySpec?: any;
  companyId?: string;
  message?: string;
}

export default function CompanyBuilderWizard() {
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const [step, setStep] = useState<WizardStep>("describe");
  const [description, setDescription] = useState("");
  const [session, setSession] = useState<BuildSession | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500">Please log in first.</p>
        <a href="/login" className="text-blue-600 hover:underline mt-2 inline-block">Go to Login</a>
      </div>
    );
  }

  async function handleDescribe() {
    if (!description.trim() || !token) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.buildCompany(token, description);
      setSession(res);
      if (res.status === "ready") {
        setStep("preview");
      } else {
        setStep("clarify");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start build");
    } finally {
      setLoading(false);
    }
  }

  async function handleAnswer() {
    if (!answer.trim() || !session || !token) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.buildAnswer(token, session.sessionId, answer);
      setSession(res);
      setAnswer("");
      if (res.status === "ready") {
        setStep("preview");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to continue");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!session || !token) return;
    setStep("creating");
    setLoading(true);
    try {
      const res = await api.buildConfirm(token, session.sessionId);
      setSession(res);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
      setStep("preview");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Create AI Company</h1>
      <p className="text-gray-500 mb-8">Describe your company idea and let AI build it for you.</p>

      {/* Progress Steps */}
      <div className="flex items-center mb-8 gap-2">
        {(["describe", "clarify", "preview", "done"] as const).map((s, i) => (
          <div key={s} className="flex items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                step === s
                  ? "bg-blue-600 text-white"
                  : ["describe", "clarify", "preview", "done"].indexOf(step) > i
                    ? "bg-green-500 text-white"
                    : "bg-gray-200 text-gray-500"
              }`}
            >
              {i + 1}
            </div>
            {i < 3 && <div className="w-12 h-0.5 bg-gray-200 mx-1" />}
          </div>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6 text-sm">
          {error}
        </div>
      )}

      {/* Step 1: Describe */}
      {step === "describe" && (
        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Describe Your Company</h2>
          <p className="text-gray-500 text-sm mb-4">
            Tell us what kind of AI company you want to build. Be as detailed as possible —
            what it does, who it serves, which channels it uses.
          </p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            placeholder="E.g.: Instagram ve TikTok icin icerik ureten bir ajans kurmak istiyorum. Hedef kitlem kucuk isletmeler..."
          />
          <button
            onClick={handleDescribe}
            disabled={loading || description.length < 10}
            className="mt-4 w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "AI is analyzing..." : "Continue"}
          </button>
        </div>
      )}

      {/* Step 2: Clarification */}
      {step === "clarify" && session && (
        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold mb-4">
            Clarification Questions (Round {session.turn}/3)
          </h2>

          {/* AI Message */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
            <p className="text-sm font-medium text-gray-600 mb-2">AI Company Builder:</p>
            <div className="text-sm text-gray-800 whitespace-pre-wrap">
              {typeof session.message === "string" ? session.message : JSON.stringify(session.message, null, 2)}
            </div>
          </div>

          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={4}
            className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            placeholder="Answer the questions..."
          />
          <button
            onClick={handleAnswer}
            disabled={loading || answer.length < 1}
            className="mt-4 w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Processing..." : "Submit Answer"}
          </button>
        </div>
      )}

      {/* Step 3: Preview */}
      {step === "preview" && session?.companySpec && (
        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Company Preview</h2>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-500">Name</label>
              <p className="text-lg font-semibold">{session.companySpec.name}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Description</label>
              <p className="text-sm text-gray-700">{session.companySpec.description}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Primitives</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {session.companySpec.primitives?.map((p: string) => (
                  <span key={p} className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full font-medium">
                    {p}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Agents ({session.companySpec.agents?.length ?? 0})</label>
              <div className="mt-1 space-y-2">
                {session.companySpec.agents?.map((a: any, i: number) => (
                  <div key={i} className="bg-gray-50 rounded-lg p-3 text-sm">
                    <span className="font-medium">{a.name}</span>
                    <span className="text-gray-500 ml-2">({a.role})</span>
                    {a.tools?.length > 0 && (
                      <div className="text-xs text-gray-400 mt-1">
                        Tools: {a.tools.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Pipelines ({session.companySpec.pipelines?.length ?? 0})</label>
              <div className="mt-1 space-y-2">
                {session.companySpec.pipelines?.map((p: any, i: number) => (
                  <div key={i} className="bg-gray-50 rounded-lg p-3 text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-gray-500 ml-2">({p.trigger})</span>
                    <div className="text-xs text-gray-400 mt-1">
                      {p.steps?.length ?? 0} steps
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => setStep("describe")}
              className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg font-medium hover:bg-gray-50"
            >
              Start Over
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="flex-1 bg-green-600 text-white py-2.5 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {loading ? "Creating..." : "Create Company"}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Creating */}
      {step === "creating" && (
        <div className="bg-white rounded-xl shadow p-12 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4" />
          <p className="text-lg font-medium">Building your AI company...</p>
          <p className="text-gray-500 text-sm mt-2">Setting up agents, pipelines, and tools.</p>
        </div>
      )}

      {/* Step 5: Done */}
      {step === "done" && session && (
        <div className="bg-white rounded-xl shadow p-8 text-center">
          <div className="text-5xl mb-4">&#10003;</div>
          <h2 className="text-2xl font-bold mb-2">Company Created!</h2>
          <p className="text-gray-500 mb-6">
            {session.companySpec?.name} is ready to go.
          </p>
          <button
            onClick={() => router.push(`/companies`)}
            className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-blue-700"
          >
            Go to Companies
          </button>
        </div>
      )}
    </div>
  );
}
