"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

export default function CompaniesPage() {
  const token = useAppStore((s) => s.token);
  const [companies, setCompanies] = useState<any[]>([]);
  const [showBuilder, setShowBuilder] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.listCompanies(token).then(setCompanies).catch(() => {});
  }, [token]);

  if (!token) return <p className="text-gray-500">Please login first.</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Companies</h1>
        <a
          href="/companies/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 inline-block"
        >
          + New Company
        </a>
      </div>

      {showBuilder && (
        <CompanyBuilder
          token={token}
          onClose={() => {
            setShowBuilder(false);
            api.listCompanies(token).then(setCompanies).catch(() => {});
          }}
        />
      )}

      {companies.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
          <p>No companies yet. Create your first AI company to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {companies.map((c) => (
            <CompanyCard key={c.id} company={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function CompanyCard({ company }: { company: any }) {
  const statusColors: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-800",
    PAUSED: "bg-yellow-100 text-yellow-800",
    DRAFT: "bg-gray-100 text-gray-800",
    ARCHIVED: "bg-red-100 text-red-800",
  };

  return (
    <a href={`/companies/${company.id}`} className="block bg-white rounded-lg shadow p-6 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-lg">{company.name}</h3>
        <span className={`text-xs px-2 py-1 rounded-full ${statusColors[company.status] ?? ""}`}>
          {company.status}
        </span>
      </div>
      <p className="text-gray-500 text-sm mb-3">{company.description ?? "No description"}</p>
      <div className="flex flex-wrap gap-1">
        {company.primitives?.map((p: string) => (
          <span key={p} className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
            {p}
          </span>
        ))}
      </div>
    </a>
  );
}

function CompanyBuilder({ token, onClose }: { token: string; onClose: () => void }) {
  const [description, setDescription] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [message, setMessage] = useState<string>("");
  const [spec, setSpec] = useState<any>(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);

  async function startBuild() {
    if (!description.trim()) return;
    setLoading(true);
    try {
      const res = await api.buildCompany(token, description);
      setSessionId(res.sessionId);
      setStatus(res.status);
      setMessage(typeof res.message === "string" ? res.message : JSON.stringify(res.message));
      setSpec(res.companySpec);
    } catch (err) {
      setMessage((err as Error).message);
    }
    setLoading(false);
  }

  async function sendAnswer() {
    if (!sessionId || !answer.trim()) return;
    setLoading(true);
    try {
      const res = await api.buildAnswer(token, sessionId, answer);
      setStatus(res.status);
      setMessage(typeof res.message === "string" ? res.message : JSON.stringify(res.message));
      setSpec(res.companySpec);
      setAnswer("");
    } catch (err) {
      setMessage((err as Error).message);
    }
    setLoading(false);
  }

  async function confirm() {
    if (!sessionId) return;
    setLoading(true);
    try {
      await api.buildConfirm(token, sessionId);
      setStatus("created");
      onClose();
    } catch (err) {
      setMessage((err as Error).message);
    }
    setLoading(false);
  }

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6 border-2 border-blue-200">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">AI Company Builder</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">X</button>
      </div>

      {!sessionId ? (
        <div>
          <p className="text-sm text-gray-500 mb-3">
            Describe the company you want to create. AI will configure everything for you.
          </p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="E.g. I want a social media agency that creates daily TikTok and LinkedIn content for B2B SaaS companies..."
            className="w-full border rounded-lg px-4 py-3 mb-4 h-32 resize-none"
          />
          <button
            onClick={startBuild}
            disabled={loading || !description.trim()}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Building..." : "Build Company"}
          </button>
        </div>
      ) : status === "clarifying" ? (
        <div>
          <div className="bg-gray-50 rounded-lg p-4 mb-4 text-sm whitespace-pre-wrap max-h-64 overflow-auto">
            {message}
          </div>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your answer..."
            className="w-full border rounded-lg px-4 py-3 mb-4 h-24 resize-none"
          />
          <button
            onClick={sendAnswer}
            disabled={loading || !answer.trim()}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Processing..." : "Answer"}
          </button>
        </div>
      ) : status === "ready" && spec ? (
        <div>
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
            <h3 className="font-semibold text-green-800 mb-2">{spec.name}</h3>
            <p className="text-sm text-green-700 mb-2">{spec.description}</p>
            <div className="flex flex-wrap gap-1 mb-2">
              {spec.primitives?.map((p: string) => (
                <span key={p} className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">{p}</span>
              ))}
            </div>
            <p className="text-xs text-green-600">
              {spec.agents?.length ?? 0} agents, {spec.pipelines?.length ?? 0} pipelines
            </p>
          </div>
          <button
            onClick={confirm}
            disabled={loading}
            className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Confirm & Create"}
          </button>
        </div>
      ) : (
        <p className="text-gray-500">Session ended.</p>
      )}
    </div>
  );
}
