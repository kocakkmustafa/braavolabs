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

export default async function BenchPage() {
  const suites = await fetchBench();

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "48px 24px", color: "#e1e2eb" }}>
      <header style={{ marginBottom: 32 }}>
        <p
          style={{
            fontSize: 11,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "#859399",
            marginBottom: 8,
          }}
        >
          Open methodology · updated weekly
        </p>
        <h1
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: 42,
            fontWeight: 700,
            margin: 0,
            lineHeight: 1.1,
          }}
        >
          Braavolabs Bench
        </h1>
        <p style={{ fontSize: 16, color: "#bbc9cf", marginTop: 12, maxWidth: 720 }}>
          We grade every supported LLM provider against fixed task suites that mirror what Braavolabs agents
          actually do: plan, decompose, decide whether to ask for approval, refuse the out-of-scope, and pin
          claims to the right audit row. The judge is a stable model (Claude Sonnet) so the leaderboard
          tracks candidate-model improvement, not judge drift.
        </p>
        <p style={{ fontSize: 12, color: "#3c494e", marginTop: 16 }}>
          Methodology + raw rubrics live in{" "}
          <Link
            href="https://github.com/kocakkmustafa/braavolabs/tree/main/packages/api/src/modules/bench/suites"
            style={{ color: "#00d1ff", textDecoration: "underline" }}
          >
            packages/api/src/modules/bench/suites
          </Link>
          . PRs welcome.
        </p>
      </header>

      {suites.length === 0 && (
        <p style={{ color: "#859399", fontSize: 14 }}>
          Bench results haven&apos;t shipped to this environment yet. Run the weekly cron to populate the leaderboard.
        </p>
      )}

      {suites.map((suite) => (
        <section key={suite.id} style={{ marginBottom: 48 }}>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 24,
              fontWeight: 700,
              margin: 0,
              marginBottom: 6,
            }}
          >
            {suite.name}
          </h2>
          <p style={{ fontSize: 14, color: "#bbc9cf", marginTop: 0, marginBottom: 18 }}>
            {suite.description}
          </p>

          {suite.leaderboard.length === 0 ? (
            <p style={{ fontSize: 13, color: "#859399" }}>No runs yet for this suite.</p>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                background: "rgba(255,255,255,0.02)",
                borderRadius: 14,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                  <th style={th}>#</th>
                  <th style={th}>Provider</th>
                  <th style={th}>Model</th>
                  <th style={{ ...th, textAlign: "right" }}>Score</th>
                  <th style={{ ...th, textAlign: "right" }}>Cost / run</th>
                  <th style={{ ...th, textAlign: "right" }}>Duration</th>
                  <th style={{ ...th, textAlign: "right" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {suite.leaderboard.map((row, idx) => (
                  <tr key={row.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <td style={td}>{idx + 1}</td>
                    <td style={td}>{row.provider}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{row.model}</td>
                    <td style={{ ...td, textAlign: "right", color: idx === 0 ? "#34d399" : "#e1e2eb", fontWeight: 600 }}>
                      {(row.scoreNormalised * 100).toFixed(1)}%
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "#bbc9cf" }}>
                      ${Number(row.costUsd).toFixed(3)}
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "#bbc9cf" }}>
                      {Math.round(row.durationMs / 1000)}s
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "#3c494e" }}>
                      {new Date(row.ranAt).toISOString().slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </main>
  );
}

const th: React.CSSProperties = {
  padding: "12px 14px",
  textAlign: "left",
  fontSize: 11,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "#859399",
};
const td: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: 13,
  color: "#e1e2eb",
};
