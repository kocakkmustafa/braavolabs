"use client";

import { useAppStore } from "../../lib/store";

export default function PipelinesPage() {
  const token = useAppStore((s) => s.token);

  if (!token) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ background: "#10131a" }}>
        <p style={{ color: "#859399" }}>
          Please <a href="/login" style={{ color: "#00d1ff" }}>login</a> first.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>AI Workflows</h1>
        <p className="text-sm mt-0.5" style={{ color: "#859399" }}>Manage your automated pipelines and workflows.</p>
      </div>
      <div className="glass-panel rounded-2xl text-center py-20">
        <span className="material-symbols-outlined text-4xl mb-4 block" style={{ color: "#00d1ff" }}>account_tree</span>
        <p className="font-semibold" style={{ color: "#e1e2eb" }}>No workflows yet</p>
        <p className="text-sm mt-1" style={{ color: "#859399" }}>Create a company first to see its pipelines here.</p>
        <a
          href="/companies/new"
          className="inline-flex items-center gap-2 mt-6 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
          style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}
        >
          Create Company
        </a>
      </div>
    </div>
  );
}
