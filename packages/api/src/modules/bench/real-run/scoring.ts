import type { Scorer } from "./set";

/** Deterministic score in [0,1], rounded to 6 decimals. */
export function scoreAnswer(scorer: Scorer, answer: string): number {
  if (scorer.kind === "label") {
    const m = /\b(APPROVE|AUTO|REFUSE)\b/.exec(answer);
    return m && m[1] === scorer.expected ? 1 : 0;
  }
  if (scorer.maxWords !== undefined) {
    const words = answer.trim().split(/\s+/).filter(Boolean).length;
    if (words > scorer.maxWords) return 0;
  }
  const hay = answer.toLowerCase();
  const matched = scorer.groups.filter((g) => g.some((alt) => hay.includes(alt.toLowerCase()))).length;
  return Math.round((matched / scorer.groups.length) * 1e6) / 1e6;
}
