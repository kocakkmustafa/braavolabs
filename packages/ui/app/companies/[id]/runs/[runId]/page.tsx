"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, apiFetch } from "../../../../../lib/api";
import { useAppStore } from "../../../../../lib/store";

interface RunStep {
  id: string;
  name: string;
  stepIndex: number;
  status: string;
  reasoning: string;
  input: any;
  output: any;
  costUsd: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  toolCalls: Array<{
    id: string;
    toolName: string;
    input: any;
    output: any;
    status: string;
    durationMs: number;
    error: string | null;
  }>;
}

interface RunDetail {
  id: string;
  status: string;
  costUsd: number;
  createdAt: string;
  completedAt: string | null;
  steps: RunStep[];
  pipeline: { name: string; company: { name: string } };
}

export default function RunDetailPage() {
  const params = useParams();
  const token = useAppStore((s) => s.token);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !params.runId) return;
    api.getRun(token, params.runId as string).then(setRun).catch((e) => setError(e.message));
  }, [token, params.runId]);

  async function handleAction(action: string) {
    if (!token || !run) return;
    setActionLoading(action);
    try {
      await apiFetch(`/runs/${run.id}/${action}`, { method: "POST", token });
      const updated = await api.getRun(token, run.id);
      setRun(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleStepAction(stepId: string, action: "rollback" | "rerun") {
    if (!token) return;
    setActionLoading(`${action}_${stepId}`);
    try {
      await apiFetch(`/runs/steps/${stepId}/${action}`, { method: "POST", token });
      const updated = await api.getRun(token, run!.id);
      setRun(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Step action failed");
    } finally {
      setActionLoading(null);
    }
  }

  if (!token) return <p className="text-slate-500 p-8">Please log in first.</p>;
  if (error) return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl">{error}</div>
    </div>
  );
  if (!run) return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="animate-shimmer h-8 w-48 rounded-lg mb-4" />
      <div className="animate-shimmer h-32 rounded-2xl" />
    </div>
  );

  const statusColors: Record<string, string> = {
    RUNNING: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    COMPLETED: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    FAILED: "bg-red-500/10 text-red-400 border-red-500/20",
    CANCELLED: "bg-slate-500/10 text-slate-400 border-slate-500/20",
    PAUSED: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    WAITING_APPROVAL: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    ROLLED_BACK: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  };

  const stepDotColors: Record<string, string> = {
    COMPLETED: "bg-emerald-500",
    RUNNING: "bg-blue-500 animate-pulse",
    FAILED: "bg-red-500",
    ROLLED_BACK: "bg-purple-500",
    PAUSED: "bg-amber-500",
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Run Detail</h1>
          <p className="text-slate-500 text-sm mt-1">
            {run.pipeline.company.name} / {run.pipeline.name}
          </p>
        </div>
        <div className="flex gap-2">
          {run.status === "RUNNING" && (
            <>
              <button
                onClick={() => handleAction("pause")}
                disabled={!!actionLoading}
                className="px-4 py-2 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-xl text-sm font-semibold hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
              >
                Pause
              </button>
              <button
                onClick={() => handleAction("stop")}
                disabled={!!actionLoading}
                className="px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl text-sm font-semibold hover:bg-red-500/20 disabled:opacity-50 transition-colors"
              >
                Hard Stop
              </button>
            </>
          )}
          {run.status === "PAUSED" && (
            <button
              onClick={() => handleAction("resume")}
              disabled={!!actionLoading}
              className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              Resume
            </button>
          )}
        </div>
      </div>

      {/* Run Summary */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="card-glass p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Status</p>
          <span className={`inline-block px-2 py-1 rounded-lg text-xs font-semibold border ${statusColors[run.status] ?? "bg-slate-500/10 text-slate-400 border-slate-500/20"}`}>
            {run.status}
          </span>
        </div>
        <div className="card-glass p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Steps</p>
          <p className="text-xl font-bold text-slate-100 mt-1">{run.steps.length}</p>
        </div>
        <div className="card-glass p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Cost</p>
          <p className="text-xl font-bold text-slate-100 mt-1">${(run.costUsd ?? 0).toFixed(4)}</p>
        </div>
        <div className="card-glass p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Duration</p>
          <p className="text-xl font-bold text-slate-100 mt-1">
            {run.completedAt
              ? `${((new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 1000).toFixed(1)}s`
              : "..."}
          </p>
        </div>
      </div>

      {/* Step Timeline */}
      <h2 className="text-base font-semibold text-slate-200 mb-4">Step Timeline</h2>
      <div className="space-y-3">
        {run.steps.map((step, idx) => (
          <div key={step.id} className="card-glass overflow-hidden">
            {/* Step Header */}
            <button
              onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
              className="w-full flex items-center gap-4 p-4 text-left hover:bg-white/[0.03] transition-colors"
            >
              {/* Timeline dot */}
              <div className="flex flex-col items-center">
                <div className={`w-3.5 h-3.5 rounded-full ${stepDotColors[step.status] ?? "bg-slate-600"}`} />
                {idx < run.steps.length - 1 && <div className="w-0.5 h-6 bg-white/[0.06] mt-1" />}
              </div>

              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-200">{step.name}</span>
                  <span className={`px-2 py-0.5 rounded-lg text-xs font-semibold border ${statusColors[step.status] ?? "bg-slate-500/10 text-slate-400 border-slate-500/20"}`}>
                    {step.status}
                  </span>
                </div>
                {step.reasoning && (
                  <p className="text-xs text-slate-500 mt-1 line-clamp-1">{step.reasoning}</p>
                )}
              </div>

              <div className="text-right text-xs text-slate-500">
                <div>${(step.costUsd ?? 0).toFixed(4)}</div>
                <div>{step.toolCalls.length} tool calls</div>
              </div>
            </button>

            {/* Expanded Detail */}
            {expandedStep === step.id && (
              <div className="border-t border-white/[0.06] px-4 pb-4 pt-3">
                {/* Reasoning */}
                {step.reasoning && (
                  <div className="mb-4">
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Reasoning</h4>
                    <p className="text-sm text-slate-300 bg-brand-500/5 border border-brand-500/10 p-3 rounded-xl whitespace-pre-wrap">{step.reasoning}</p>
                  </div>
                )}

                {/* Error */}
                {step.error && (
                  <div className="mb-4">
                    <h4 className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">Error</h4>
                    <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 p-3 rounded-xl">{step.error}</p>
                  </div>
                )}

                {/* Tool Calls */}
                {step.toolCalls.length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Tool Calls</h4>
                    <div className="space-y-2">
                      {step.toolCalls.map((tc) => (
                        <div key={tc.id} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-mono font-medium text-slate-300">{tc.toolName}</span>
                            <div className="flex items-center gap-2">
                              <span className={tc.status === "COMPLETED" ? "text-emerald-400" : "text-red-400"}>
                                {tc.status}
                              </span>
                              <span className="text-slate-600">{tc.durationMs}ms</span>
                            </div>
                          </div>
                          {tc.input && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-slate-500 hover:text-slate-400">Input</summary>
                              <pre className="mt-1 bg-black/20 text-slate-400 p-2 rounded-lg text-xs overflow-auto max-h-32">
                                {JSON.stringify(tc.input, null, 2)}
                              </pre>
                            </details>
                          )}
                          {tc.output && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-slate-500 hover:text-slate-400">Output</summary>
                              <pre className="mt-1 bg-black/20 text-slate-400 p-2 rounded-lg text-xs overflow-auto max-h-32">
                                {JSON.stringify(tc.output, null, 2)}
                              </pre>
                            </details>
                          )}
                          {tc.error && (
                            <p className="text-red-400 mt-1">{tc.error}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Step Actions */}
                <div className="flex gap-2">
                  {(step.status === "COMPLETED" || step.status === "FAILED") && (
                    <button
                      onClick={() => handleStepAction(step.id, "rollback")}
                      disabled={!!actionLoading}
                      className="px-3 py-1.5 border border-white/[0.08] text-slate-400 rounded-xl text-sm font-semibold hover:bg-white/[0.06] disabled:opacity-50 transition-colors"
                    >
                      Rollback
                    </button>
                  )}
                  {(step.status === "FAILED" || step.status === "ROLLED_BACK") && (
                    <button
                      onClick={() => handleStepAction(step.id, "rerun")}
                      disabled={!!actionLoading}
                      className="px-3 py-1.5 gradient-brand text-white rounded-xl text-sm font-semibold hover:shadow-md hover:shadow-brand-500/20 disabled:opacity-50 transition-all"
                    >
                      Rerun Step
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
