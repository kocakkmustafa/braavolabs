"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAppStore } from "../lib/store";
import { api } from "../lib/api";

interface ChecklistItem {
  key: string;
  label: string;
  description: string;
  href: string;
  icon: string;
}

const CHECKLIST: ChecklistItem[] = [
  { key: "registered", label: "Create an account", description: "Sign up for AI Company OS", href: "/login", icon: "person_add" },
  { key: "heroCompanyCreated", label: "Create your first company", description: "Build an AI company from a description", href: "/onboarding", icon: "business" },
  { key: "firstRunCompleted", label: "Run your first pipeline", description: "Execute an automated workflow", href: "/pipelines", icon: "play_circle" },
  { key: "firstDraftApproved", label: "Review a draft", description: "Approve or edit AI-generated content", href: "/drafts", icon: "edit_note" },
  { key: "profileCompleted", label: "Complete your profile", description: "Add your name and preferences", href: "/settings", icon: "badge" },
];

export default function OnboardingChecklist() {
  const token = useAppStore((s) => s.token);
  const [steps, setSteps] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.onboardingStatus(token).then((s) => {
      setSteps(s.steps);
      setProgress(s.progress);
    }).catch(() => {});
  }, [token]);

  if (!token || dismissed || progress >= 100) return null;

  const completedCount = CHECKLIST.filter((item) => steps[item.key]).length;
  const pct = Math.round((completedCount / CHECKLIST.length) * 100);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 55,
        width: expanded ? 340 : "auto",
        maxHeight: expanded ? "calc(100vh - 100px)" : "auto",
        overflowY: expanded ? "auto" as const : "visible" as const,
        pointerEvents: "auto" as const,
      }}
    >
      {/* Collapsed: floating badge */}
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-3 px-4 py-3 rounded-2xl transition-all hover:brightness-110"
          style={{
            background: "linear-gradient(135deg, rgba(0,209,255,0.15), rgba(109,17,173,0.15))",
            border: "1px solid rgba(0,209,255,0.25)",
            backdropFilter: "blur(16px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ width: 32, height: 32, position: "relative" }}>
            <svg viewBox="0 0 36 36" width="32" height="32">
              <path
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3"
              />
              <path
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none" stroke="#00d1ff" strokeWidth="3"
                strokeDasharray={`${pct}, 100`} strokeLinecap="round"
              />
            </svg>
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#00d1ff" }}>
              {pct}%
            </span>
          </div>
          <div className="text-left">
            <p className="text-xs font-semibold" style={{ color: "#e1e2eb" }}>Setup Progress</p>
            <p className="text-[10px]" style={{ color: "#859399" }}>{completedCount}/{CHECKLIST.length} completed</p>
          </div>
        </button>
      )}

      {/* Expanded panel */}
      {expanded && (
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: "rgba(16,19,26,0.97)",
            border: "1px solid rgba(0,209,255,0.15)",
            backdropFilter: "blur(20px)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#00d1ff" }}>rocket_launch</span>
              <span className="text-sm font-semibold" style={{ color: "#e1e2eb" }}>Getting Started</span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setDismissed(true)} className="text-xs" style={{ color: "#3c494e" }}>Dismiss</button>
              <button onClick={() => setExpanded(false)}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#859399" }}>close</span>
              </button>
            </div>
          </div>

          {/* Progress bar */}
          <div className="px-4 pt-3 pb-2">
            <div className="flex justify-between mb-1">
              <span className="text-[10px]" style={{ color: "#859399" }}>{completedCount} of {CHECKLIST.length} complete</span>
              <span className="text-[10px] font-bold" style={{ color: "#00d1ff" }}>{pct}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: "linear-gradient(90deg,#00d1ff,#6d11ad)" }} />
            </div>
          </div>

          {/* Checklist items */}
          <div className="px-2 py-2">
            {CHECKLIST.map((item) => {
              const done = steps[item.key];
              return (
                <Link
                  key={item.key}
                  href={done ? "#" : item.href}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all"
                  style={{ textDecoration: "none", opacity: done ? 0.5 : 1 }}
                  onClick={(e) => { if (done) e.preventDefault(); }}
                  onMouseEnter={(e) => { if (!done) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{
                      background: done ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.04)",
                      border: done ? "1px solid rgba(52,211,153,0.3)" : "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    {done ? (
                      <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#34d399" }}>check</span>
                    ) : (
                      <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#859399" }}>{item.icon}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium" style={{ color: done ? "#859399" : "#e1e2eb", textDecoration: done ? "line-through" : "none" }}>{item.label}</p>
                    <p className="text-[10px]" style={{ color: "#3c494e" }}>{item.description}</p>
                  </div>
                  {!done && (
                    <span className="material-symbols-outlined flex-shrink-0 ml-auto" style={{ fontSize: 14, color: "#3c494e" }}>chevron_right</span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
