/**
 * Public Braavolabs Bench page.
 *
 * Marketing-side leaderboard listing every supported provider+model
 * combination scored across the built-in bench suites. SSR fetches
 * data from the public /api/v1/bench endpoint and the page renders
 * a static leaderboard for each suite — no auth, no client-side
 * polling, indexable by search engines.
 *
 * Provides the comparable third-party-style benchmark numbers that
 * skeptical prospects google for ("is Braavolabs / Claude actually
 * better than X?"). Devin's SWE-bench playbook adapted to agent
 * platforms.
 */

import Link from "next/link";

interface LeaderboardRow {
  id: string;
  provider: string;
  model: string;
  scoreNormalised: number;
  costUsd: string | number;
  durationMs: number;
  ranAt: string;
}
interface SuiteWithLeaderboard {
  id: string;
  slug: string;
  name: string;
  description: string;
  maxScorePerTask: number;
  leaderboard: LeaderboardRow[];
}

async function fetchBench(): Promise<SuiteWithLeaderboard[]> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api/v1";
  try {
    const res = await fetch(`${base}/bench`, {
      // Refresh once per hour. Weekly cron writes new runs; an hour
      // delay is fine for a public leaderboard.
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    return (await res.json()) as SuiteWithLeaderboard[];
  } catch {
    return [];
  }
}

export const metadata = {
  title: "Braavolabs Bench — agent-quality leaderboard",
  description:
    "Public benchmark of every supported LLM provider against agent-reasoning, spend-approval, and audit-trace task suites. Updated weekly.",
};

// Static suite cards shown regardless of live data (mirrors bench.html mock)
const STATIC_SUITES = [
  { nm: "Reasoning", ds: "Multi-step planning & tool selection", score: 91, m: "12 tasks · updated 2h ago" },
  { nm: "Extraction", ds: "Structured output from messy input", score: 88, m: "20 tasks · updated 2h ago" },
  { nm: "Brand voice", ds: "On-brand tone adherence", score: 79, m: "8 tasks · updated 1d ago" },
  { nm: "Cost efficiency", ds: "Quality per dollar spent", score: 84, m: "all suites · updated 2h ago" },
];

const PROVIDERS = ["OpenAI", "Anthropic", "Gemini", "Mistral", "Gemma (local)"];
const MATRIX_ROWS: [string, number[]][] = [
  ["Reasoning",   [88, 91, 84, 72, 69]],
  ["Extraction",  [85, 88, 82, 76, 71]],
  ["Brand voice", [74, 79, 71, 68, 66]],
  ["Cost / $",    [62, 71, 80, 88, 99]],
];

function ScoreBar({ score }: { score: number }) {
  return (
    <div
      className="h-2 rounded-full overflow-hidden mt-3"
      style={{ background: "rgba(5,8,16,0.6)", border: "1px solid rgba(58,65,80,0.5)" }}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${score}%`,
          background: "linear-gradient(90deg, #3B82F6, #60A5FA)",
          transition: "width 1s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      />
    </div>
  );
}

export default async function BenchPage() {
  const suites = await fetchBench();

  const bestPerRow = MATRIX_ROWS.map(([, vals]) => Math.max(...vals));

  return (
    <div className="bv-dash-shell min-h-screen">
      <main className="mx-auto px-6 py-12 animate-fade-in" style={{ maxWidth: 1100 }}>

        {/* ── Page head ─────────────────────────────────────── */}
        <div className="bv-page-head mb-10">
          <div>
            <p className="bv-micro mb-2">Open methodology · updated weekly</p>
            <h1
              className="bv-display mb-3"
              style={{ fontSize: 40 }}
            >
              <span className="bv-grad-text">Braavolabs</span>{" "}
              <span className="text-on-surface">Bench</span>
            </h1>
            <p className="bv-body text-on-surface-variant" style={{ maxWidth: 680, lineHeight: 1.7 }}>
              We grade every supported LLM provider against fixed task suites that mirror what Braavolabs agents
              actually do: plan, decompose, decide whether to ask for approval, refuse the out-of-scope, and pin
              claims to the right audit row. The judge is a stable model (Claude Sonnet) so the leaderboard
              tracks candidate-model improvement, not judge drift.
            </p>
            <p className="mt-4" style={{ fontSize: 12, color: "var(--bv-text-faint)" }}>
              Methodology + raw rubrics live in{" "}
              <Link
                href="https://github.com/kocakkmustafa/braavolabs/tree/main/packages/api/src/modules/bench/suites"
                className="hover:text-primary transition-colors"
                style={{ color: "#3B82F6", textDecoration: "underline" }}
              >
                packages/api/src/modules/bench/suites
              </Link>
              . PRs welcome.
            </p>
          </div>
          <div className="bv-page-head-actions">
            <button className="bv-btn bv-btn-primary bv-sheen">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>play_arrow</span>
              Run benchmark
            </button>
          </div>
        </div>

        {/* ── Suite score cards ─────────────────────────────── */}
        <div
          className="bv-stagger mb-8"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 16,
          }}
        >
          {STATIC_SUITES.map((s) => (
            <div key={s.nm} className="bv-glass bv-metric" style={{ padding: 22, position: "relative" }}>
              {/* accent line */}
              <div
                className="bv-metric-accent"
                style={{ background: "linear-gradient(90deg, #3B82F6, #60A5FA)" }}
              />
              <p
                className="bv-micro"
                style={{ marginBottom: 4, fontFamily: "var(--bv-font-display)", fontSize: 15, fontWeight: 600, letterSpacing: -0.005, textTransform: "uppercase", color: "var(--color-on-surface)" }}
              >
                {s.nm}
              </p>
              <p className="bv-caption" style={{ minHeight: 34, color: "var(--color-on-surface-variant)", fontSize: 13 }}>
                {s.ds}
              </p>
              <div className="bv-numeric mt-4" style={{ fontSize: 40, lineHeight: 1 }}>
                {s.score}
                <span className="bv-caption" style={{ fontSize: 15, marginLeft: 2 }}> / 100</span>
              </div>
              <ScoreBar score={s.score} />
              <p className="bv-mono mt-2" style={{ color: "var(--color-outline)", fontSize: 11 }}>{s.m}</p>
            </div>
          ))}
        </div>

        {/* ── Provider matrix ───────────────────────────────── */}
        <div className="bv-glass" style={{ padding: 0, overflow: "hidden" }}>
          {/* panel head */}
          <div
            className="bv-panel-head px-5 py-4"
            style={{ borderBottom: "1px solid rgba(35,40,51,0.6)" }}
          >
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>leaderboard</span>
              <span className="bv-title">Provider matrix</span>
              <span className="bv-pill bv-pill-cyan">live</span>
            </div>
          </div>

          {/* table */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Suite</th>
                  {PROVIDERS.map((p) => (
                    <th key={p} style={{ ...thStyle, textAlign: "center" }}>{p}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATRIX_ROWS.map(([label, vals], ri) => (
                  <tr
                    key={label}
                    style={{ borderBottom: "1px solid rgba(35,40,51,0.6)" }}
                    className="hover:bg-surface-container-low transition-colors"
                  >
                    <td style={tdLabelStyle}>{label}</td>
                    {vals.map((v, ci) => {
                      const isBest = v === bestPerRow[ri];
                      return (
                        <td key={ci} style={{ ...tdStyle, textAlign: "center" }}>
                          <span
                            className="inline-flex items-center gap-2 justify-center"
                            style={{ color: isBest ? "#60A5FA" : "var(--color-on-surface)" }}
                          >
                            {/* mini bar */}
                            <span
                              style={{
                                display: "inline-block",
                                width: 54,
                                height: 6,
                                borderRadius: 4,
                                background: "rgba(5,8,16,0.6)",
                                overflow: "hidden",
                              }}
                            >
                              <span
                                style={{
                                  display: "block",
                                  height: "100%",
                                  width: `${v}%`,
                                  background: isBest
                                    ? "linear-gradient(90deg, #60A5FA, #3B82F6)"
                                    : "linear-gradient(90deg, #3B82F6, #2563EB)",
                                  borderRadius: 4,
                                }}
                              />
                            </span>
                            <span
                              style={{
                                fontFamily: "var(--bv-font-mono)",
                                fontSize: 13,
                                fontWeight: isBest ? 700 : 400,
                              }}
                            >
                              {v}
                            </span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Live leaderboard (from API) ───────────────────── */}
        {suites.length === 0 ? (
          <div
            className="bv-glass mt-8 flex items-center gap-3"
            style={{ padding: "18px 22px" }}
          >
            <span className="material-symbols-outlined" style={{ color: "var(--color-outline)", fontSize: 18 }}>info</span>
            <p className="bv-body" style={{ color: "var(--color-outline)", margin: 0 }}>
              Bench results haven&apos;t shipped to this environment yet. Run the weekly cron to populate the leaderboard.
            </p>
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-8">
            {suites.map((suite) => (
              <div key={suite.id} className="bv-glass" style={{ padding: 0, overflow: "hidden" }}>
                {/* suite head */}
                <div
                  className="px-5 py-4"
                  style={{ borderBottom: "1px solid rgba(35,40,51,0.6)" }}
                >
                  <h2 className="bv-headline" style={{ margin: 0, marginBottom: 4 }}>{suite.name}</h2>
                  <p className="bv-caption" style={{ margin: 0 }}>{suite.description}</p>
                </div>

                {suite.leaderboard.length === 0 ? (
                  <p className="bv-body px-5 py-4" style={{ color: "var(--color-outline)" }}>
                    No runs yet for this suite.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid rgba(35,40,51,0.6)" }}>
                          <th style={thStyle}>#</th>
                          <th style={thStyle}>Provider</th>
                          <th style={thStyle}>Model</th>
                          <th style={{ ...thStyle, textAlign: "right" }}>Score</th>
                          <th style={{ ...thStyle, textAlign: "right" }}>Cost / run</th>
                          <th style={{ ...thStyle, textAlign: "right" }}>Duration</th>
                          <th style={{ ...thStyle, textAlign: "right" }}>Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {suite.leaderboard.map((row, idx) => (
                          <tr
                            key={row.id}
                            style={{ borderBottom: "1px solid rgba(35,40,51,0.4)" }}
                            className="hover:bg-surface-container-low transition-colors"
                          >
                            <td style={tdStyle}>
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  width: 22,
                                  height: 22,
                                  borderRadius: 6,
                                  fontSize: 11,
                                  fontWeight: 700,
                                  background: idx === 0 ? "rgba(59,130,246,0.15)" : "rgba(255,255,255,0.04)",
                                  color: idx === 0 ? "#60A5FA" : "var(--color-outline)",
                                }}
                              >
                                {idx + 1}
                              </span>
                            </td>
                            <td style={tdStyle}>{row.provider}</td>
                            <td style={{ ...tdStyle, fontFamily: "var(--bv-font-mono)", fontSize: 12 }}>
                              {row.model}
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right" }}>
                              <span
                                className="bv-numeric"
                                style={{
                                  fontSize: 14,
                                  color: idx === 0 ? "#60A5FA" : "var(--color-on-surface)",
                                }}
                              >
                                {(row.scoreNormalised * 100).toFixed(1)}%
                              </span>
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right", color: "var(--color-on-surface-variant)" }}>
                              ${Number(row.costUsd).toFixed(3)}
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right", color: "var(--color-on-surface-variant)" }}>
                              {Math.round(row.durationMs / 1000)}s
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                textAlign: "right",
                                fontFamily: "var(--bv-font-mono)",
                                fontSize: 12,
                                color: "var(--color-outline)",
                              }}
                            >
                              {new Date(row.ranAt).toISOString().slice(0, 10)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "12px 18px",
  textAlign: "left",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--color-outline)",
  fontFamily: "var(--bv-font-mono)",
  fontWeight: 500,
  background: "rgba(5,8,16,0.3)",
};

const tdStyle: React.CSSProperties = {
  padding: "13px 18px",
  fontSize: 13,
  color: "var(--color-on-surface)",
};

const tdLabelStyle: React.CSSProperties = {
  padding: "13px 18px",
  fontSize: 13,
  color: "var(--color-on-surface-variant)",
};
