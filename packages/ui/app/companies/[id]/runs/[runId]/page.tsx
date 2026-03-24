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

  if (!token) return <p className="text-gray-500">Please log in first.</p>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded">{error}</div>;
  if (!run) return <p className="text-gray-500">Loading run...</p>;

  const statusColors: Record<string, string> = {
    RUNNING: "bg-blue-100 text-blue-700",
    COMPLETED: "bg-green-100 text-green-700",
    FAILED: "bg-red-100 text-red-700",
    CANCELLED: "bg-gray-100 text-gray-700",
    PAUSED: "bg-yellow-100 text-yellow-700",
    WAITING_APPROVAL: "bg-orange-100 text-orange-700",
    ROLLED_BACK: "bg-purple-100 text-purple-700",
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Run Detail</h1>
          <p className="text-gray-500 text-sm mt-1">
            {run.pipeline.company.name} / {run.pipeline.name}
          </p>
        </div>
        <div className="flex gap-2">
          {run.status === "RUNNING" && (
            <>
              <button
                onClick={() => handleAction("pause")}
                disabled={!!actionLoading}
                className="px-4 py-2 bg-yellow-500 text-white rounded-lg text-sm hover:bg-yellow-600 disabled:opacity-50"
              >
                Pause
              </button>
              <button
                onClick={() => handleAction("stop")}
                disabled={!!actionLoading}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50"
              >
                Hard Stop
              </button>
            </>
          )}
          {run.status === "PAUSED" && (
            <button
              onClick={() => handleAction("resume")}
              disabled={!!actionLoading}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
            >
              Resume
            </button>
          )}
        </div>
      </div>

      {/* Run Summary */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Status</p>
          <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium mt-1 ${statusColors[run.status] ?? "bg-gray-100"}`}>
            {run.status}
          </span>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Steps</p>
          <p className="text-xl font-bold mt-1">{run.steps.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Cost</p>
          <p className="text-xl font-bold mt-1">${(run.costUsd ?? 0).toFixed(4)}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Duration</p>
          <p className="text-xl font-bold mt-1">
            {run.completedAt
              ? `${((new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 1000).toFixed(1)}s`
              : "..."}
          </p>
        </div>
      </div>

      {/* Step Timeline */}
      <h2 className="text-lg font-semibold mb-4">Step Timeline</h2>
      <div className="space-y-4">
        {run.steps.map((step, idx) => (
          <div key={step.id} className="bg-white rounded-lg shadow">
            {/* Step Header */}
            <button
              onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
              className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 rounded-lg"
            >
              {/* Timeline dot */}
              <div className="flex flex-col items-center">
                <div
                  className={`w-4 h-4 rounded-full ${
                    step.status === "COMPLETED" ? "bg-green-500" :
                    step.status === "RUNNING" ? "bg-blue-500 animate-pulse" :
                    step.status === "FAILED" ? "bg-red-500" :
                    step.status === "ROLLED_BACK" ? "bg-purple-500" :
                    "bg-gray-300"
                  }`}
                />
                {idx < run.steps.length - 1 && <div className="w-0.5 h-8 bg-gray-200 mt-1" />}
              </div>

              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{step.name}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[step.status] ?? "bg-gray-100"}`}>
                    {step.status}
                  </span>
                </div>
                {step.reasoning && (
                  <p className="text-sm text-gray-500 mt-1 line-clamp-1">{step.reasoning}</p>
                )}
              </div>

              <div className="text-right text-sm text-gray-500">
                <div>${(step.costUsd ?? 0).toFixed(4)}</div>
                <div>{step.toolCalls.length} tool calls</div>
              </div>
            </button>

            {/* Expanded Detail */}
            {expandedStep === step.id && (
              <div className="border-t px-4 pb-4 pt-3">
                {/* Reasoning */}
                {step.reasoning && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-gray-700 mb-1">Reasoning</h4>
                    <p className="text-sm text-gray-600 bg-blue-50 p-3 rounded-lg whitespace-pre-wrap">{step.reasoning}</p>
                  </div>
                )}

                {/* Error */}
                {step.error && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-red-600 mb-1">Error</h4>
                    <p className="text-sm text-red-700 bg-red-50 p-3 rounded-lg">{step.error}</p>
                  </div>
                )}

                {/* Tool Calls */}
                {step.toolCalls.length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Tool Calls</h4>
                    <div className="space-y-2">
                      {step.toolCalls.map((tc) => (
                        <div key={tc.id} className="bg-gray-50 rounded-lg p-3 text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-mono font-medium">{tc.toolName}</span>
                            <div className="flex items-center gap-2">
                              <span className={tc.status === "COMPLETED" ? "text-green-600" : "text-red-600"}>
                                {tc.status}
                              </span>
                              <span className="text-gray-400">{tc.durationMs}ms</span>
                            </div>
                          </div>
                          {tc.input && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-gray-500">Input</summary>
                              <pre className="mt-1 bg-white p-2 rounded text-xs overflow-auto max-h-32">
                                {JSON.stringify(tc.input, null, 2)}
                              </pre>
                            </details>
                          )}
                          {tc.output && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-gray-500">Output</summary>
                              <pre className="mt-1 bg-white p-2 rounded text-xs overflow-auto max-h-32">
                                {JSON.stringify(tc.output, null, 2)}
                              </pre>
                            </details>
                          )}
                          {tc.error && (
                            <p className="text-red-600 mt-1">{tc.error}</p>
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
                      className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
                    >
                      Rollback
                    </button>
                  )}
                  {(step.status === "FAILED" || step.status === "ROLLED_BACK") && (
                    <button
                      onClick={() => handleStepAction(step.id, "rerun")}
                      disabled={!!actionLoading}
                      className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
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
