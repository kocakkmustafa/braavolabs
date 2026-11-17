import type { Scorer } from "./set";

/** Part of setHash: bump on ANY change of the scoring rules below. */
export const SCORING_VERSION = "2";

/** Answers longer than this are cut for matching and halved. */
export const DEFAULT_MAX_CHARS = 1200;

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "to", "of", "and", "it", "in", "for", "that", "this",
  "be", "as", "on", "with", "by", "because", "should", "so", "if", "or",
]);
const NEGATORS = new Set(["not", "never", "no", "without", "asla", "değil", "degil", "n't"]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Alternative syntax: whole-word match (letters/digits/_ boundaries on both
 * sides); a trailing `*` makes it a prefix match (stem), e.g. `refus*`.
 */
function altRegex(alt: string): RegExp {
  const prefix = alt.endsWith("*");
  const core = escapeRe(prefix ? alt.slice(0, -1) : alt);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${core}${prefix ? "" : "(?![\\p{L}\\p{N}_])"}`, "giu");
}

/** True when one of the 3 words before `idx` (same sentence) is a negator. */
function negatedAt(text: string, idx: number): boolean {
  const before = text.slice(0, idx);
  const sentence = before.slice(Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf(";"), before.lastIndexOf("\n")) + 1);
  const words = sentence.toLowerCase().split(/\s+/).filter(Boolean).slice(-3);
  return words.some((w) => NEGATORS.has(w) || w.endsWith("n't"));
}

/** Distinct non-negated alternatives of `group` that occur in `text`. */
function matchedAlts(group: string[], text: string): string[] {
  const hits: string[] = [];
  for (const alt of group) {
    const re = altRegex(alt);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!negatedAt(text, m.index)) { hits.push(alt); break; }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return hits;
}

/** Stuffing: 4+ synonyms of one group, or matched keywords dominate a longer answer. */
const STUFF_SAME_GROUP = 4;
const STUFF_DENSITY = 0.5;
const STUFF_MIN_WORDS = 10;

/** Deterministic score in [0,1], rounded to 6 decimals. */
export function scoreAnswer(scorer: Scorer, answer: string): number {
  if (scorer.kind === "label") {
    const head = answer.slice(0, 80);
    const distinct = new Set(head.match(/\b(APPROVE|AUTO|REFUSE)\b/g) ?? []);
    if (distinct.size !== 1) return 0;
    const m = /^[\s*_`"'(\[#>-]*(APPROVE|AUTO|REFUSE)\b/.exec(answer);
    return m && m[1] === scorer.expected ? 1 : 0;
  }
  const maxChars = scorer.maxChars ?? DEFAULT_MAX_CHARS;
  if (scorer.maxWords !== undefined) {
    const words = answer.trim().split(/\s+/).filter(Boolean).length;
    if (words > scorer.maxWords) return 0;
  }
  const over = answer.length > maxChars;
  const text = over ? answer.slice(0, maxChars) : answer;
  const hits = scorer.groups.map((g) => matchedAlts(g, text));
  let score = hits.filter((h) => h.length > 0).length / scorer.groups.length;
  // Prose check: keyword lists without function words, or dominated by keywords, are stuffing.
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const stop = text.toLowerCase().split(/[^a-z']+/).filter((w) => STOPWORDS.has(w)).length;
  const keywordWords = hits.flat().reduce((n, a) => n + a.replace(/\*$/, "").split(/[\s-]+/).length, 0);
  const stuffed =
    stop < 2 ||
    hits.some((h) => h.length >= STUFF_SAME_GROUP) ||
    (words >= STUFF_MIN_WORDS && keywordWords / words > STUFF_DENSITY);
  if (stuffed) score *= 0.25;
  if (over) score *= 0.5;
  return Math.round(score * 1e6) / 1e6;
}
