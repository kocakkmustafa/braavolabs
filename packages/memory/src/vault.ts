/**
 * Obsidian-LIKE least-token project memory — vault writer (Vibe P1a, THE MOAT).
 *
 * Reference implementation to drop into packages/memory/src/vault.ts. The
 * moat: an autonomous, model-agnostic, plain-Markdown project brain that the
 * cheap continuous tier keeps fresh for pennies. Everything here is PURE (render
 * functions return Markdown strings) so it is fully unit-testable with zero
 * secrets / disk / network. The thin `MarkdownVault` class takes an injectable
 * FsAdapter so the same logic works over a real vault (Obsidian-AWARE) or our
 * own store (Obsidian-LIKE).
 *
 * Design principles (from VIBECODING-VISION-ROADMAP §4-5):
 *  - Structured + retrieved, never re-read whole → few tokens.
 *  - [[wikilinked]] hub + per-area status + dated decision log + agentskills.io
 *    skill files + habits profile — user-inspectable, git-diffable.
 *  - Idempotent, deterministic output (stable for git diffs).
 */

/** An Obsidian `[[wikilink]]`. Strips characters Obsidian forbids in note names. */
export function wikilink(noteName: string, alias?: string): string {
  const clean = noteName.replace(/[[\]|#^]/g, "").trim();
  return alias ? `[[${clean}|${alias}]]` : `[[${clean}]]`;
}

/** A stable YAML frontmatter block from an ordered key/value map. */
export function frontmatter(fields: Record<string, string | number | string[]>): string {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    return `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`;
  });
  return `---\n${lines.join("\n")}\n---`;
}

export interface HubArea {
  /** Note name of the per-area status note (linked from the hub). */
  note: string;
  /** One-line summary shown next to the link. */
  summary: string;
}

/** The project hub note — the single entry point, linking every area note. */
export function renderHub(args: {
  project: string;
  updated: string; // ISO date, injected (no Date.now in pure code)
  northStar: string;
  areas: HubArea[];
}): string {
  const { project, updated, northStar, areas } = args;
  const body = [
    frontmatter({ type: "project-hub", project, updated }),
    "",
    `# 🧭 ${project} — Project Brain`,
    "",
    `> North star: ${northStar}`,
    `> Last updated: ${updated}`,
    "",
    "## Areas",
    ...areas.map((a) => `- ${wikilink(a.note)} — ${a.summary}`),
    "",
  ];
  return body.join("\n");
}

/** A per-area status note. */
export function renderStatusNote(args: {
  area: string;
  updated: string;
  status: string;
  bullets: string[];
  hub: string;
}): string {
  const { area, updated, status, bullets, hub } = args;
  return [
    frontmatter({ type: "area-status", area, updated, status }),
    "",
    `# ${area}`,
    "",
    `**Status:** ${status}`,
    "",
    ...bullets.map((b) => `- ${b}`),
    "",
    `↩ ${wikilink(hub)}`,
    "",
  ].join("\n");
}

/** One dated entry appended to the decision/change log (newest-first). */
export function renderDecisionEntry(args: {
  date: string;
  title: string;
  detail: string;
  by?: string; // which model/agent recorded it (cheap tier by default)
}): string {
  const { date, title, detail, by } = args;
  const attr = by ? ` _(${by})_` : "";
  return `### ${date} — ${title}${attr}\n${detail}\n`;
}

/**
 * Append an entry to a dated log, newest-first, under a stable heading.
 * Idempotent-friendly: callers pass the existing content; we insert after the
 * heading line so the file stays a clean, git-diffable append.
 */
export function appendToDatedLog(existing: string, entry: string, heading = "# Decision & Change Log"): string {
  const trimmed = existing.trimEnd();
  if (!trimmed) return `${heading}\n\n${entry.trimEnd()}\n`;
  const idx = trimmed.indexOf(heading);
  if (idx === -1) return `${heading}\n\n${entry.trimEnd()}\n\n${trimmed}\n`;
  const headEnd = idx + heading.length;
  const before = trimmed.slice(0, headEnd);
  const after = trimmed.slice(headEnd).replace(/^\n+/, "");
  return `${before}\n\n${entry.trimEnd()}\n\n${after}\n`;
}

/** An agentskills.io-style reusable skill file (self-improving procedural memory). */
export function renderSkill(args: {
  name: string;
  description: string;
  when: string;
  steps: string[];
}): string {
  const { name, description, when, steps } = args;
  return [
    frontmatter({ type: "skill", name, description }),
    "",
    `# ${name}`,
    "",
    description,
    "",
    `**When to use:** ${when}`,
    "",
    "## Steps",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
  ].join("\n");
}

export interface HabitsProfile {
  updated: string;
  modelPreferences: { taskType: string; model: string; evidence: string }[];
  conventions: string[];
  recurringIssues: { issue: string; count: number }[];
}

/** The cross-session habits profile (evidence-cited; drives the coach in P6). */
export function renderHabits(p: HabitsProfile): string {
  return [
    frontmatter({ type: "habits", updated: p.updated }),
    "",
    "# Coding Habits (learned)",
    "",
    "## Preferred model per task",
    ...p.modelPreferences.map((m) => `- **${m.taskType}** → ${m.model} _(${m.evidence})_`),
    "",
    "## Conventions",
    ...p.conventions.map((c) => `- ${c}`),
    "",
    "## Recurring issues (coach candidates)",
    ...p.recurringIssues.map((r) => `- ${r.issue} — seen ${r.count}×`),
    "",
  ].join("\n");
}

/** Minimal filesystem port so the same logic serves LIKE (own store) or AWARE (real vault). */
export interface FsAdapter {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

/** Thin orchestrator over the pure renderers + an injected FS. */
export class MarkdownVault {
  constructor(
    private fs: FsAdapter,
    private root = "",
  ) {}

  private p(name: string): string {
    const base = this.root ? `${this.root.replace(/\/$/, "")}/` : "";
    return `${base}${name}.md`;
  }

  async writeHub(args: Parameters<typeof renderHub>[0]): Promise<void> {
    await this.fs.write(this.p(`🧭 ${args.project} — Project Brain`), renderHub(args));
  }
  async writeStatus(args: Parameters<typeof renderStatusNote>[0]): Promise<void> {
    await this.fs.write(this.p(args.area), renderStatusNote(args));
  }
  async logDecision(entryArgs: Parameters<typeof renderDecisionEntry>[0], logNote = "Decision & Change Log"): Promise<void> {
    const path = this.p(logNote);
    const existing = (await this.fs.read(path)) ?? "";
    await this.fs.write(path, appendToDatedLog(existing, renderDecisionEntry(entryArgs)));
  }
  async writeSkill(args: Parameters<typeof renderSkill>[0]): Promise<void> {
    await this.fs.write(this.p(`skills/${args.name}`), renderSkill(args));
  }
  async writeHabits(p: HabitsProfile): Promise<void> {
    await this.fs.write(this.p("Coding Habits"), renderHabits(p));
  }
}
