"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useAuthGuard } from "@/lib/useAuthGuard";

export default function ExportPage() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuthGuard();
  const t = useTranslations();
  const [bundle, setBundle] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [format, setFormat] = useState("claude-code");
  const [copied, setCopied] = useState("");

  const loadBundle = async () => {
    if (!token || !id) return;
    setLoading(true);
    try {
      const data = await api.exportBundle(token, id as string, format);
      setBundle(data);
    } catch (err) {
      console.error("Export failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBundle();
  }, [token, id, format]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!token) return null;

  return (
    <div className="bv-mesh min-h-screen">
      <div className="max-w-[1020px] mx-auto px-6 py-8 bv-rise">

        {/* Page head */}
        <div className="bv-page-head mb-7">
          <div>
            <p className="bv-micro mb-1 text-on-surface-variant">
              {t("app.exportBundle.title")}
            </p>
            <h1 className="bv-headline text-on-surface">
              Export workspace
            </h1>
            <p className="bv-body text-on-surface-variant mt-1">
              {t("app.exportBundle.subtitle")}
            </p>
          </div>
        </div>

        {/* Format selector */}
        <div className="flex gap-2 mb-6 bv-segmented w-fit">
          {["claude-code", "n8n", "generic"].map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={format === f ? "active" : ""}
            >
              {f === "claude-code"
                ? t("app.exportBundle.fmtClaudeCode")
                : f === "n8n"
                ? "n8n"
                : t("app.exportBundle.fmtGeneric")}
            </button>
          ))}
        </div>

        {/* Two-column layout: main + sticky side */}
        <div className="bv-twocol">
          {/* ── Left: bundle contents ── */}
          <div className="bv-twocol-main">

            {/* Loading state */}
            {loading && (
              <div className="bv-glass bv-panel items-center justify-center py-12">
                <span
                  className="material-symbols-outlined text-primary mb-3"
                  style={{ fontSize: 36, animation: "spin-slow 1s linear infinite" }}
                >
                  progress_activity
                </span>
                <p className="bv-caption">{t("app.exportBundle.generating")}</p>
              </div>
            )}

            {bundle && !loading && (
              <div className="bv-stagger flex flex-col gap-4">

                {/* CLAUDE.md */}
                <div className="bv-glass overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>
                        description
                      </span>
                      <span className="bv-title text-sm font-semibold">CLAUDE.md</span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => copyToClipboard(bundle.claudeMd, "claude-md")}
                        className={`bv-btn bv-btn-sm ${copied === "claude-md" ? "bv-btn-primary" : "bv-btn-ghost"}`}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 13 }}>
                          {copied === "claude-md" ? "check" : "content_copy"}
                        </span>
                        {copied === "claude-md"
                          ? t("app.exportBundle.copied")
                          : t("app.exportBundle.copy")}
                      </button>
                      <button
                        onClick={() => downloadFile(bundle.claudeMd, "CLAUDE.md")}
                        className="bv-btn bv-btn-sm bv-btn-ghost"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 13 }}>download</span>
                        {t("app.exportBundle.download")}
                      </button>
                    </div>
                  </div>
                  <pre
                    className="bv-mono text-on-surface-variant p-4 m-0 max-h-72 overflow-auto"
                    style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}
                  >
                    {bundle.claudeMd}
                  </pre>
                </div>

                {/* Skills */}
                <div className="bv-glass bv-panel">
                  <div className="bv-panel-head">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--color-secondary)" }}>
                        psychology
                      </span>
                      <span className="bv-title text-sm font-semibold">
                        {t("app.exportBundle.skillsTitle", { n: bundle.skills.length })}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    {bundle.skills.map((skill: any, i: number) => (
                      <div
                        key={i}
                        className="interactive-row flex items-center justify-between px-3 py-2.5 rounded-xl"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="bv-body font-semibold text-on-surface">{skill.name}</span>
                          <span className="bv-mono ml-2" style={{ color: "var(--bv-text-faint)" }}>
                            {skill.fileName}
                          </span>
                        </div>
                        <div className="flex gap-2 flex-shrink-0 ml-3">
                          <button
                            onClick={() => copyToClipboard(skill.content, `skill-${i}`)}
                            className={`bv-btn bv-btn-sm ${copied === `skill-${i}` ? "bv-btn-primary" : "bv-btn-ghost"}`}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>
                              {copied === `skill-${i}` ? "check" : "content_copy"}
                            </span>
                            {copied === `skill-${i}`
                              ? t("app.exportBundle.copied")
                              : t("app.exportBundle.copy")}
                          </button>
                          <button
                            onClick={() => downloadFile(skill.content, skill.fileName)}
                            className="bv-btn bv-btn-sm bv-btn-ghost"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>download</span>
                            {t("app.exportBundle.download")}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Hooks */}
                <div className="bv-glass bv-panel">
                  <div className="bv-panel-head">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--bv-status-running)" }}>
                        webhook
                      </span>
                      <span className="bv-title text-sm font-semibold">
                        {t("app.exportBundle.hooksTitle", { n: bundle.hooks.length })}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    {bundle.hooks.map((hook: any, i: number) => (
                      <div
                        key={i}
                        className="interactive-row flex items-center justify-between px-3 py-2.5 rounded-xl"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span
                            className={`bv-pill ${hook.event === "cron" ? "bv-pill-cyan" : "bv-pill-amber"}`}
                          >
                            {hook.event.toUpperCase()}
                          </span>
                          <span className="bv-body text-on-surface truncate">{hook.description}</span>
                        </div>
                        <button
                          onClick={() => downloadFile(hook.content, hook.fileName)}
                          className="bv-btn bv-btn-sm bv-btn-ghost flex-shrink-0 ml-3"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>download</span>
                          {t("app.exportBundle.download")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            )}
          </div>

          {/* ── Right: sticky bundle summary ── */}
          <div className="bv-twocol-side">
            <div className="bv-glass bv-panel sticky top-20">
              <div className="bv-panel-head">
                <p className="bv-micro">Bundle summary</p>
              </div>

              {/* Encryption badge */}
              <div
                className="flex items-center gap-3 px-3 py-3 rounded-xl border"
                style={{
                  background: "rgba(59,130,246,0.06)",
                  borderColor: "rgba(59,130,246,0.25)",
                }}
              >
                <div
                  className="flex items-center justify-center rounded-xl flex-shrink-0"
                  style={{
                    width: 34,
                    height: 34,
                    background: "rgba(59,130,246,0.12)",
                    border: "1px solid rgba(59,130,246,0.30)",
                  }}
                >
                  <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>
                    lock
                  </span>
                </div>
                <div>
                  <p className="bv-body font-semibold text-on-surface">AES-256 encrypted bundle</p>
                  <p className="bv-caption">A one-time passphrase is generated on export</p>
                </div>
              </div>

              <div className="bv-divider" />

              {/* Summary rows */}
              {bundle && (
                <div className="flex flex-col gap-0">
                  {[
                    { label: "Workspace", value: bundle.company?.name || bundle.company?.slug || "—" },
                    { label: "Skills", value: `${bundle.skills?.length ?? 0}` },
                    { label: "Hooks", value: `${bundle.hooks?.length ?? 0}` },
                    { label: "Encryption", value: "AES-256" },
                  ].map(({ label, value }, idx, arr) => (
                    <div
                      key={label}
                      className="flex items-center justify-between py-2.5"
                      style={
                        idx < arr.length - 1
                          ? { borderBottom: "1px solid var(--bv-glass-border)" }
                          : {}
                      }
                    >
                      <span className="bv-caption">{label}</span>
                      <span className="bv-mono text-on-surface font-semibold" style={{ fontSize: 12 }}>
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {!bundle && !loading && (
                <div className="flex flex-col gap-2.5">
                  {["Workspace", "Components", "Estimated size", "Encryption"].map((label) => (
                    <div key={label} className="flex items-center justify-between py-2" style={{ borderBottom: "1px solid var(--bv-glass-border)" }}>
                      <span className="bv-caption">{label}</span>
                      <span className="animate-shimmer rounded w-16 h-3 block" />
                    </div>
                  ))}
                </div>
              )}

              {/* Download all */}
              {bundle && !loading && (
                <button
                  onClick={() =>
                    downloadFile(
                      JSON.stringify(bundle, null, 2),
                      `${bundle.company?.slug || "company"}-export.json`
                    )
                  }
                  className="bv-btn bv-btn-primary w-full justify-center mt-1"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                    download
                  </span>
                  {t("app.exportBundle.downloadAll")}
                </button>
              )}

              {loading && (
                <div className="flex flex-col items-center py-4 gap-3">
                  <div
                    className="rounded-full border-2 border-outline-variant"
                    style={{
                      width: 44,
                      height: 44,
                      borderTopColor: "var(--color-primary)",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                  <p className="bv-caption">{t("app.exportBundle.generating")}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
