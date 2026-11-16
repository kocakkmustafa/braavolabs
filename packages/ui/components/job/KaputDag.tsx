/**
 * BRA-P1-01-N2 — Kaput: adım bağımlılık grafiği (DAG). Yeni bağımlılık yok: SVG + CSS, topolojik seviye → sütun.
 * Veri `buildKaputGraph` (saf) çıktısıdır; kaynak yoksa "veri yok" + sıralı liste (kenar uydurulmaz).
 * Erişilebilirlik: SVG `role="img"` + özet etiketi; asıl okunur yol, bağımlılıkları yazan sıralı liste. Durum rengi + glif + metin.
 */
import { GRAPH_MAX_NODES, type KaputGraph, type KaputStep } from "../../lib/ux-lab/facts";
import { safeText } from "../../lib/ux-kaput/mask";
import type { T } from "../inbox/InboxParts";

const NODE_W = 160, NODE_H = 52, COL_GAP = 48, ROW_GAP = 14, PAD = 8, LABEL_MAX = 20;
const GLYPH: Record<string, string> = { completed: "✓", failed: "✕", running: "…", pending: "○", skipped: "–", cancelled: "⊘" };
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };
const wrap: React.CSSProperties = { overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0 };

export function KaputDag({ graph, steps, t, rtl, status, statusKey, nameMax }: {
  graph: KaputGraph; steps: KaputStep[]; t: T; rtl: boolean; status: (raw: string) => string;
  statusKey: (raw: string) => string | null; nameMax: number;
}) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const shown = graph.source === "none" ? steps.slice(0, GRAPH_MAX_NODES) : steps.filter((s) => graph.nodes.some((n) => n.id === s.id));
  const num = new Map(steps.map((s, i) => [s.id, i + 1]));
  const hasGraph = graph.source !== "none" && graph.nodes.length > 0;
  const deps = new Map<string, number[]>();
  for (const e of graph.edges) deps.set(e.to, [...(deps.get(e.to) ?? []), num.get(e.from) as number]);
  const rows = Math.max(1, ...graph.levels.map((l) => l.length));
  const W = graph.levels.length * NODE_W + Math.max(0, graph.levels.length - 1) * COL_GAP + PAD * 2;
  const H = rows * NODE_H + Math.max(0, rows - 1) * ROW_GAP + PAD * 2;
  const pos = new Map<string, { x: number; y: number }>();
  graph.levels.forEach((ids, l) => ids.forEach((id, r) => {
    const x0 = PAD + l * (NODE_W + COL_GAP);
    pos.set(id, { x: rtl ? W - x0 - NODE_W : x0, y: PAD + r * (NODE_H + ROW_GAP) });
  }));
  return (
    <section data-testid="job-kaput-dag" aria-label={t("app.jobs.kaput.dag.title")} style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <strong style={{ fontSize: 14 }}>{t("app.jobs.kaput.dag.title")}</strong>
      {!hasGraph && <span role="status" data-testid="job-kaput-dag-nodata" style={muted}>{t("app.jobs.kaput.dag.noData")}</span>}
      {!graph.consistent && <span role="status" data-testid="job-kaput-dag-inconsistent" style={{ ...muted, color: "var(--color-error)" }}>{t("app.jobs.kaput.dag.inconsistent")}</span>}
      {hasGraph && (
        <>
          <span style={muted}>{t(graph.source === "order" ? "app.jobs.kaput.dag.sourceOrder" : "app.jobs.kaput.dag.sourceApi")}</span>
          <div tabIndex={0} role="group" aria-label={t("app.jobs.kaput.dag.scroll")} dir={rtl ? "rtl" : undefined}
            style={{ overflowX: "auto", maxWidth: "100%", borderRadius: 10, border: "1px solid var(--color-surface-container-highest)", background: "var(--color-surface-container)" }}>
            <svg role="img" width={W} height={H} viewBox={`0 0 ${W} ${H}`} data-testid="job-kaput-dag-svg"
              aria-label={t("app.jobs.kaput.dag.summary", { steps: graph.nodes.length, levels: graph.levels.length, edges: graph.edges.length })}>
              {graph.edges.map((e) => {
                const a = pos.get(e.from), b = pos.get(e.to);
                if (!a || !b) return null;
                const x1 = rtl ? a.x : a.x + NODE_W, x2 = rtl ? b.x + NODE_W : b.x, y1 = a.y + NODE_H / 2, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
                return <path key={`${e.from}>${e.to}`} data-testid="job-kaput-dag-edge" d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} fill="none" stroke="var(--color-on-surface-variant)" strokeWidth={1.5} />;
              })}
              {graph.nodes.map((n) => {
                const s = byId.get(n.id), p = pos.get(n.id);
                if (!s || !p) return null;
                const key = statusKey(s.status), failed = key === "failed";
                const tx = rtl ? p.x + NODE_W - 10 : p.x + 10;
                return (
                  <g key={n.id} data-testid="job-kaput-dag-node">
                    <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={10} fill="var(--color-surface)" stroke={failed ? "var(--color-error)" : "var(--color-surface-container-highest)"} strokeWidth={failed ? 2.5 : 1.5} strokeDasharray={key === "completed" || failed ? undefined : "4 3"} />
                    <text x={tx} y={p.y + 21} textAnchor={rtl ? "end" : "start"} fontSize={13} fontWeight={600} fill="var(--color-on-surface)">{`${num.get(s.id)}. ${safeText(s.name, LABEL_MAX)}`}</text>
                    <text x={tx} y={p.y + 40} textAnchor={rtl ? "end" : "start"} fontSize={12} fill={failed ? "var(--color-error)" : "var(--color-on-surface-variant)"}>{`${GLYPH[key ?? ""] ?? "?"} ${status(s.status)}`}</text>
                  </g>
                );
              })}
            </svg>
          </div>
        </>
      )}
      {graph.truncated && <span role="status" data-testid="job-kaput-dag-truncated" style={muted}>{t("app.jobs.kaput.dag.truncated", { shown: Math.min(graph.total, GRAPH_MAX_NODES), total: graph.total })}</span>}
      <ol aria-label={t("app.jobs.kaput.dag.listLabel")} data-testid="job-kaput-dag-list" style={{ margin: 0, paddingInlineStart: 22, display: "grid", gap: 4 }}>
        {shown.map((s) => {
          const d = deps.get(s.id);
          return (
            <li key={s.id} style={wrap}>
              <span dir="auto">{safeText(s.name, nameMax)}</span> · {status(s.status)}
              {hasGraph && <span style={muted}> · {d && d.length ? t("app.jobs.kaput.dag.dependsOn", { steps: [...d].sort((x, y) => x - y).join(", ") }) : t("app.jobs.kaput.dag.noDeps")}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
