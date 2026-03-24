"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-800",
  REVIEW: "bg-yellow-100 text-yellow-800",
  APPROVED: "bg-green-100 text-green-800",
  PUBLISHED: "bg-blue-100 text-blue-800",
  REJECTED: "bg-red-100 text-red-800",
};

const TYPE_LABELS: Record<string, string> = {
  SOCIAL_POST: "Social Post",
  EMAIL: "Email",
  BLOG_POST: "Blog Post",
  AD_COPY: "Ad Copy",
  VIDEO_SCRIPT: "Video Script",
};

export default function DraftsPage() {
  const token = useAppStore((s) => s.token);
  const [companies, setCompanies] = useState<any[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>("");
  const [drafts, setDrafts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.listCompanies(token).then((list) => {
      setCompanies(list);
      if (list.length > 0) setSelectedCompany(list[0].id);
    }).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token || !selectedCompany) return;
    setLoading(true);
    api.listDrafts(token, selectedCompany)
      .then(setDrafts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, selectedCompany]);

  if (!token) return <p className="text-gray-500">Please login first.</p>;

  async function updateStatus(id: string, status: string) {
    try {
      await api.updateDraft(token!, id, { status });
      setDrafts((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status } : d))
      );
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Drafts</h1>
        <select
          value={selectedCompany}
          onChange={(e) => setSelectedCompany(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading drafts...</p>
      ) : drafts.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
          <p>No drafts yet. Drafts will appear here when agents create content.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {drafts.map((d) => (
            <div key={d.id} className="bg-white rounded-lg shadow p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold">{d.title}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[d.status] ?? ""}`}>
                      {d.status}
                    </span>
                    <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded">
                      {TYPE_LABELS[d.type] ?? d.type}
                    </span>
                  </div>
                  {d.channel && (
                    <p className="text-sm text-gray-500">Channel: {d.channel}</p>
                  )}
                  {d.content && (
                    <div className="mt-2 text-sm text-gray-700 bg-gray-50 rounded p-3 max-h-32 overflow-auto whitespace-pre-wrap">
                      {typeof d.content === "string" ? d.content : JSON.stringify(d.content, null, 2)}
                    </div>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                    <span>Created: {new Date(d.createdAt).toLocaleString()}</span>
                    {d.scheduledAt && (
                      <span>Scheduled: {new Date(d.scheduledAt).toLocaleString()}</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 ml-4">
                  {d.status === "DRAFT" && (
                    <button
                      onClick={() => updateStatus(d.id, "APPROVED")}
                      className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-green-700"
                    >
                      Approve
                    </button>
                  )}
                  {(d.status === "DRAFT" || d.status === "REVIEW") && (
                    <button
                      onClick={() => updateStatus(d.id, "REJECTED")}
                      className="bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-red-700"
                    >
                      Reject
                    </button>
                  )}
                  {d.status === "APPROVED" && (
                    <button
                      onClick={() => updateStatus(d.id, "PUBLISHED")}
                      className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700"
                    >
                      Publish
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
