"use client";

/**
 * Import an external automation as a Braavolabs Pipeline.
 *
 * Surface for the importer endpoints in
 * packages/api/src/modules/automation-importer/. The user picks a
 * source format, pastes the raw payload, hits Preview to see what'd
 * land + which nodes drop, and then Commit to persist as a Pipeline.
 *
 * Intentionally minimal — no drag-drop / file upload yet. Paste-only
 * keeps the flow synchronous and avoids the multipart / oversized-
 * upload edge cases on day one. File upload is a follow-up.
 */

import { useState } from "react";
import Link from "next/link";
import { api } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";

type Source =
  | "n8n"
  | "claude-automation"
  | "claude-code-routine"
  | "openclaw"
  | "nemoclaw"
  | "mcp"
  | "generic";

const SOURCES: { id: Source; label: string; hint: string; sample: string }[] = [
  {
    id: "n8n",
    label: "n8n workflow",
    hint: "Export your workflow as JSON (n8n → Workflows → … → Export). Paste the file contents here.",
    sample: '{"name":"My workflow","nodes":[{"type":"n8n-nodes-base.httpRequest","name":"HTTP","parameters":{"url":"https://api.example.com"}}],"connections":{}}',
  },
  {
    id: "claude-automation",
    label: "Claude Automation routine",
    hint: "Markdown body (with optional YAML frontmatter) describing your routine. h2 sections become steps.",
    sample: "## Plan\n\nResearch the topic.\n\n## Implementation\n\nWrite the article.",
  },
  {
    id: "claude-code-routine",
    label: "Claude Code auto-dev routine",
    hint: "Same markdown shape as Claude Automation — used for .claude/routines/*.md playbooks.",
    sample: "---\nrole: auto-dev\n---\n\n## Plan\n\n…",
  },
  {
    id: "openclaw",
    label: "OpenClaw skill bundle",
    hint: "manifest.json from an OpenClaw export. Tools and prompts both convert.",
    sample: '{"name":"My skill","description":"…","tools":[{"name":"search","description":"…"}],"prompts":{"system":"You are…"}}',
  },
  {
    id: "nemoclaw",
    label: "NemoClaw skill bundle",
    hint: "Same manifest shape as OpenClaw.",
    sample: '{"name":"My skill","tools":[],"prompts":{"system":"You are…"}}',
  },
  {
    id: "mcp",
    label: "MCP server.json",
    hint: "Server descriptor with tools[] and resources[]. Tools map to mcp.invoke steps.",
    sample: '{"name":"My MCP","tools":[{"name":"search","description":"Web search","inputSchema":{}}]}',
  },
  {
    id: "generic",
    label: "Generic graph (nodes + edges JSON)",
    hint: "Last-resort schema: { name, nodes:[{id,type,config}], edges:[{from,to}] }.",
    sample: '{"name":"My pipeline","nodes":[{"id":"a","type":"http","config":{"url":"…"}}],"edges":[]}',
  },
];

export default function ImportAutomationPage() {
  const { token, hydrated } = useAuthGuard();
  const [source, setSource] = useState<Source>("n8n");
  const [name, setName] = useState("");
  const [payload, setPayload] = useState("");
  const [preview, setPreview] = useState<{
    name: string;
    description?: string;
    steps: Array<{ id: string; type: string; config: unknown }>;
    dropped: Array<{ id: string; type: string; reason: string }>;
    warnings: string[];
  } | null>(null);
  const [committedId, setCommittedId] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hydrated) return null;

  const currentSource = SOURCES.find((s) => s.id === source)!;

  const onPreview = async () => {
    if (!token) return;
    setLoadingPreview(true);
    setError(null);
    setCommittedId(null);
    try {
      const resp = await api.importAutomationPreview(token, {
        source,
        payload,
        name: name || undefined,
      });
      setPreview({
        name: resp.preview.name,
        description: resp.preview.description,
        steps: resp.preview.steps,
        dropped: resp.droppedNodes,
        warnings: resp.warnings,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
      setPreview(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const onCommit = async () => {
    if (!token || !preview) return;
    setCommitting(true);
    setError(null);
    try {
      const resp = await api.importAutomationCommit(token, {
        source,
        payload,
        name: name || undefined,
      });
      setCommittedId(resp.pipelineId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14", color: "#bbc9cf" }}>
      <div className="max-w-[960px] mx-auto px-6 py-12">
        <div className="mb-2">
          <Link href="/integrations" style={{ color: "#a4e6ff", fontSize: 13 }}>
            ← Back to Integrations
          </Link>
        </div>
        <h1
          className="font-headline font-extrabold"
          style={{ fontSize: "2rem", color: "#e1e2eb", marginBottom: 8 }}
        >
          Import an automation
        </h1>
        <p style={{ fontSize: 14, marginBottom: 32, lineHeight: 1.6 }}>
          Bring a workflow from another tool into Braavolabs as a runnable pipeline.
          Paste the source payload, preview the conversion, and commit. Original
          payload is preserved on the pipeline so you can re-import after a
          converter improvement.
        </p>

        {/* Source picker */}
        <label style={{ fontSize: 13, color: "#e1e2eb", fontWeight: 600, display: "block", marginBottom: 8 }}>
          Source format
        </label>
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value as Source);
            setPreview(null);
            setCommittedId(null);
          }}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(255,255,255,0.04)",
            color: "#e1e2eb",
            fontSize: 14,
            marginBottom: 6,
          }}
        >
          {SOURCES.map((s) => (
            <option key={s.id} value={s.id} style={{ background: "#0a0d14", color: "#e1e2eb" }}>
              {s.label}
            </option>
          ))}
        </select>
        <p style={{ fontSize: 12, color: "#859399", marginBottom: 20 }}>{currentSource.hint}</p>

        {/* Name */}
        <label style={{ fontSize: 13, color: "#e1e2eb", fontWeight: 600, display: "block", marginBottom: 8 }}>
          Pipeline name <span style={{ color: "#3c494e", fontWeight: 400 }}>(optional)</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Imported workflow"
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(255,255,255,0.04)",
            color: "#e1e2eb",
            fontSize: 14,
            marginBottom: 20,
          }}
        />

        {/* Payload textarea */}
        <label style={{ fontSize: 13, color: "#e1e2eb", fontWeight: 600, display: "block", marginBottom: 8 }}>
          Source payload
        </label>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder={currentSource.sample}
          rows={12}
          style={{
            width: "100%",
            padding: "12px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(255,255,255,0.04)",
            color: "#e1e2eb",
            fontSize: 12,
            fontFamily: "monospace",
            marginBottom: 16,
            resize: "vertical",
          }}
        />

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
          <button
            onClick={onPreview}
            disabled={!payload.trim() || loadingPreview}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.06)",
              color: "#e1e2eb",
              fontSize: 13,
              fontWeight: 600,
              cursor: payload.trim() ? "pointer" : "not-allowed",
              opacity: payload.trim() ? 1 : 0.5,
            }}
          >
            {loadingPreview ? "Previewing…" : "Preview"}
          </button>
          <button
            onClick={onCommit}
            disabled={!preview || committing}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: "none",
              background: preview
                ? "linear-gradient(135deg, #00d1ff, #6d11ad)"
                : "rgba(255,255,255,0.06)",
              color: preview ? "#fff" : "#3c494e",
              fontSize: 13,
              fontWeight: 700,
              cursor: preview ? "pointer" : "not-allowed",
            }}
          >
            {committing ? "Importing…" : "Import as pipeline"}
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              border: "1px solid rgba(248,113,113,0.3)",
              background: "rgba(248,113,113,0.1)",
              color: "#fca5a5",
              fontSize: 13,
              marginBottom: 24,
            }}
          >
            {error}
          </div>
        )}

        {committedId && (
          <div
            style={{
              padding: 16,
              borderRadius: 10,
              border: "1px solid rgba(52,211,153,0.3)",
              background: "rgba(52,211,153,0.08)",
              color: "#86efac",
              fontSize: 13,
              marginBottom: 24,
              lineHeight: 1.6,
            }}
          >
            Pipeline created.{" "}
            <Link href={`/pipelines/${committedId}`} style={{ color: "#a4e6ff", textDecoration: "underline" }}>
              Open it →
            </Link>
          </div>
        )}

        {preview && (
          <div
            style={{
              padding: 20,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <h2 style={{ fontSize: 16, color: "#e1e2eb", fontWeight: 700, marginBottom: 4 }}>
              {preview.name}
            </h2>
            {preview.description && (
              <p style={{ fontSize: 13, color: "#859399", marginBottom: 16 }}>{preview.description}</p>
            )}

            <h3 style={{ fontSize: 12, color: "#e1e2eb", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Steps ({preview.steps.length})
            </h3>
            <div style={{ marginBottom: 16 }}>
              {preview.steps.map((step) => (
                <div
                  key={step.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "8px 0",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: "#e1e2eb" }}>{step.id}</span>
                  <span style={{ color: "#859399", fontFamily: "monospace", fontSize: 12 }}>{step.type}</span>
                </div>
              ))}
            </div>

            {preview.dropped.length > 0 && (
              <>
                <h3 style={{ fontSize: 12, color: "#fbbf24", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Dropped ({preview.dropped.length})
                </h3>
                <div style={{ marginBottom: 16 }}>
                  {preview.dropped.map((d) => (
                    <div
                      key={d.id}
                      style={{
                        padding: 8,
                        borderRadius: 8,
                        background: "rgba(251,191,36,0.05)",
                        border: "1px solid rgba(251,191,36,0.15)",
                        marginBottom: 6,
                        fontSize: 12,
                      }}
                    >
                      <div style={{ color: "#fbbf24", fontFamily: "monospace", marginBottom: 2 }}>
                        {d.type}
                      </div>
                      <div style={{ color: "#bbc9cf" }}>{d.reason}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {preview.warnings.length > 0 && (
              <ul style={{ paddingLeft: 16, fontSize: 12, color: "#bbc9cf" }}>
                {preview.warnings.map((w, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
