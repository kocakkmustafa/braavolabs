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
    <div style={{ padding: "32px", maxWidth: 960, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700,
          fontSize: 24,
          color: "#e1e2eb",
          marginBottom: 8,
        }}>
          {t("app.exportBundle.title")}
        </h1>
        <p style={{ color: "#859399", fontSize: 14 }}>
          {t("app.exportBundle.subtitle")}
        </p>
      </div>

      {/* Format selector */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {["claude-code", "n8n", "generic"].map((f) => (
          <button
            key={f}
            onClick={() => setFormat(f)}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              border: format === f ? "1px solid #00d1ff" : "1px solid rgba(255,255,255,0.1)",
              background: format === f ? "rgba(0,209,255,0.1)" : "rgba(29,32,38,0.7)",
              color: format === f ? "#00d1ff" : "#859399",
              cursor: "pointer",
            }}
          >
            {f === "claude-code" ? t("app.exportBundle.fmtClaudeCode") : f === "n8n" ? "n8n" : t("app.exportBundle.fmtGeneric")}
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ color: "#859399", padding: 40, textAlign: "center" }}>
          <span className="material-symbols-outlined" style={{ fontSize: 32, animation: "spin 1s linear infinite" }}>progress_activity</span>
          <p>{t("app.exportBundle.generating")}</p>
        </div>
      )}

      {bundle && !loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* CLAUDE.md Section */}
          <div style={{
            background: "rgba(29,32,38,0.7)",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.06)",
            overflow: "hidden",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#00d1ff" }}>description</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: "#e1e2eb" }}>CLAUDE.md</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => copyToClipboard(bundle.claudeMd, "claude-md")}
                  style={{
                    padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                    background: copied === "claude-md" ? "#34d399" : "rgba(0,209,255,0.1)",
                    color: copied === "claude-md" ? "#fff" : "#00d1ff",
                    border: "none", cursor: "pointer",
                  }}
                >
                  {copied === "claude-md" ? t("app.exportBundle.copied") : t("app.exportBundle.copy")}
                </button>
                <button
                  onClick={() => downloadFile(bundle.claudeMd, "CLAUDE.md")}
                  style={{
                    padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                    background: "rgba(0,209,255,0.1)", color: "#00d1ff",
                    border: "none", cursor: "pointer",
                  }}
                >
                  {t("app.exportBundle.download")}
                </button>
              </div>
            </div>
            <pre style={{
              padding: 16, margin: 0, fontSize: 12, lineHeight: 1.6,
              color: "#859399", maxHeight: 300, overflow: "auto",
              fontFamily: "monospace", whiteSpace: "pre-wrap",
            }}>
              {bundle.claudeMd}
            </pre>
          </div>

          {/* Skills Section */}
          <div style={{
            background: "rgba(29,32,38,0.7)",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.06)",
            padding: 16,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#c084fc" }}>psychology</span>
              <span style={{ fontWeight: 600, fontSize: 14, color: "#e1e2eb" }}>
                {t("app.exportBundle.skillsTitle", { n: bundle.skills.length })}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {bundle.skills.map((skill: any, i: number) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 14px", borderRadius: 8,
                  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.04)",
                }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#e1e2eb" }}>{skill.name}</span>
                    <span style={{ fontSize: 11, color: "#3c494e", marginLeft: 8 }}>{skill.fileName}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => copyToClipboard(skill.content, `skill-${i}`)}
                      style={{
                        padding: "3px 8px", borderRadius: 4, fontSize: 10,
                        background: copied === `skill-${i}` ? "#34d399" : "rgba(255,255,255,0.05)",
                        color: copied === `skill-${i}` ? "#fff" : "#859399",
                        border: "none", cursor: "pointer",
                      }}
                    >
                      {copied === `skill-${i}` ? t("app.exportBundle.copied") : t("app.exportBundle.copy")}
                    </button>
                    <button
                      onClick={() => downloadFile(skill.content, skill.fileName)}
                      style={{
                        padding: "3px 8px", borderRadius: 4, fontSize: 10,
                        background: "rgba(255,255,255,0.05)", color: "#859399",
                        border: "none", cursor: "pointer",
                      }}
                    >
                      {t("app.exportBundle.download")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Hooks Section */}
          <div style={{
            background: "rgba(29,32,38,0.7)",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.06)",
            padding: 16,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#fbbf24" }}>webhook</span>
              <span style={{ fontWeight: 600, fontSize: 14, color: "#e1e2eb" }}>
                {t("app.exportBundle.hooksTitle", { n: bundle.hooks.length })}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {bundle.hooks.map((hook: any, i: number) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 14px", borderRadius: 8,
                  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.04)",
                }}>
                  <div>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                      background: hook.event === "cron" ? "rgba(0,209,255,0.1)" : "rgba(251,191,36,0.1)",
                      color: hook.event === "cron" ? "#00d1ff" : "#fbbf24",
                      marginRight: 8,
                    }}>
                      {hook.event.toUpperCase()}
                    </span>
                    <span style={{ fontSize: 13, color: "#e1e2eb" }}>{hook.description}</span>
                  </div>
                  <button
                    onClick={() => downloadFile(hook.content, hook.fileName)}
                    style={{
                      padding: "3px 8px", borderRadius: 4, fontSize: 10,
                      background: "rgba(255,255,255,0.05)", color: "#859399",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    {t("app.exportBundle.download")}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Download All button */}
          <button
            onClick={() => downloadFile(JSON.stringify(bundle, null, 2), `${bundle.company?.slug || "company"}-export.json`)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              padding: "14px 24px", borderRadius: 12, fontWeight: 700, fontSize: 14,
              background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
              color: "white", border: "none", cursor: "pointer",
              boxShadow: "0 0 20px rgba(0,209,255,0.2)",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>download</span>
            {t("app.exportBundle.downloadAll")}
          </button>
        </div>
      )}
    </div>
  );
}
