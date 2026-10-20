import { getLocale } from "next-intl/server";
import { formatCurrency, formatDurationMs, formatNumber } from "../../i18n/locales";
import { getTranslations as getSeoTranslations } from "next-intl/server";

import { getTranslations as getLegacyTranslations } from "next-intl/server";
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
import { connection } from "next/server";

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

import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("m6bec3a9f230a"),
  description:
    seo("mcbea634da00e"),
  alternates: { canonical: "https://braavolabs.com/bench" },
  openGraph: {
    title: seo("m6bec3a9f230a"),
    description:
      seo("mcbea634da00e"),
    url: "https://braavolabs.com/bench",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default async function BenchPage() {
  const locale = await getLocale();
  const uiText = await getLegacyTranslations("uiCopy");
  // Fetch live data only while serving a request. The hourly data-cache policy
  // below still applies, but building the UI must not probe the deployed API.
  await connection();
  const suites = await fetchBench();

  return (
    <div className="bv-dash-shell min-h-screen">
      <main className="mx-auto px-6 py-12 animate-fade-in" style={{ maxWidth: 1100 }}>

        {/* ── Page head ─────────────────────────────────────── */}
        <div className="bv-page-head mb-10">
          <div>
            <p className="bv-micro mb-2">{uiText("me1bb55c0e7b4")}</p>
            <h1
              className="bv-display mb-3"
              style={{ fontSize: 40 }}
            >
              <span className="bv-grad-text">Braavolabs</span>{" "}
              <span className="text-on-surface">{uiText("mba85f9df1e3f")}</span>
            </h1>
            <p className="bv-body text-on-surface-variant" style={{ maxWidth: 680, lineHeight: 1.7 }}>{uiText("m3ea665b949b5")}</p>
            <p className="mt-4" style={{ fontSize: 12, color: "var(--bv-text-faint)" }}>{uiText("madef7e96db5b")}{" "}
              <Link
                href="https://github.com/kocakkmustafa/braavolabs/tree/main/packages/api/src/modules/bench/suites"
                className="hover:text-primary transition-colors"
                style={{ color: "#3B82F6", textDecoration: "underline" }}
              >{"packages/api/src/modules/bench/suites"}</Link>{uiText("m4106b4c7e011")}</p>
          </div>
        </div>

        {/* ── Live leaderboard (from API) ───────────────────── */}
        {suites.length === 0 ? (
          <div
            className="bv-glass mt-8 flex items-center gap-3"
            style={{ padding: "18px 22px" }}
          >
            <span className="material-symbols-outlined" style={{ color: "var(--color-outline)", fontSize: 18 }}>info</span>
            <p className="bv-body" style={{ color: "var(--color-outline)", margin: 0 }}>{uiText("mbe9a5bbdd9b6")}</p>
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
                  <p className="bv-body px-5 py-4" style={{ color: "var(--color-outline)" }}>{uiText("m4349735a6625")}</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid rgba(35,40,51,0.6)" }}>
                          <th style={thStyle}>#</th>
                          <th style={thStyle}>{uiText("m62d2447bfb31")}</th>
                          <th style={thStyle}>{uiText("m53b77436d18d")}</th>
                          <th style={{ ...thStyle, textAlign: "end" }}>{uiText("m6853e500c770")}</th>
                          <th style={{ ...thStyle, textAlign: "end" }}>{uiText("m2dbf116102ae")}</th>
                          <th style={{ ...thStyle, textAlign: "end" }}>{uiText("m41b4f721faf5")}</th>
                          <th style={{ ...thStyle, textAlign: "end" }}>{uiText("m881b035daeb6")}</th>
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
                                  color: idx === 0 ? "var(--color-primary)" : "var(--color-outline)",
                                }}
                              >
                                {idx + 1}
                              </span>
                            </td>
                            <td style={tdStyle}>{row.provider}</td>
                            <td style={{ ...tdStyle, fontFamily: "var(--bv-font-mono)", fontSize: 12 }}>
                              {row.model}
                            </td>
                            <td style={{ ...tdStyle, textAlign: "end" }}>
                              <span
                                className="bv-numeric"
                                style={{
                                  fontSize: 14,
                                  color: idx === 0 ? "var(--color-primary)" : "var(--color-on-surface)",
                                }}
                              >
                                {formatNumber(row.scoreNormalised, locale, { style: "percent", maximumFractionDigits: 1 })}
                              </span>
                            </td>
                            <td style={{ ...tdStyle, textAlign: "end", color: "var(--color-on-surface-variant)" }}>
                              {formatCurrency(row.costUsd, "USD", locale, { maximumFractionDigits: 4 })}
                            </td>
                            <td style={{ ...tdStyle, textAlign: "end", color: "var(--color-on-surface-variant)" }}>
                              {formatDurationMs(row.durationMs, locale)}
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                textAlign: "end",
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
  textAlign: "start",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--color-outline)",
  fontFamily: "var(--bv-font-mono)",
  fontWeight: 500,
  background: "var(--color-surface-container-low)",
};

const tdStyle: React.CSSProperties = {
  padding: "13px 18px",
  fontSize: 13,
  color: "var(--color-on-surface)",
};
