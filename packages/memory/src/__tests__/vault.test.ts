/**
 * Tests for the Obsidian-LIKE least-token memory vault writer (Forge P1a / P2 — THE MOAT).
 * All pure: zero secrets / disk / network. Verifies deterministic, git-diff-stable
 * Markdown output + the MarkdownVault orchestrator over an in-memory FsAdapter.
 */
import { describe, it, expect } from "vitest";
import {
  wikilink,
  frontmatter,
  renderHub,
  renderStatusNote,
  renderDecisionEntry,
  appendToDatedLog,
  renderSkill,
  renderHabits,
  MarkdownVault,
  type FsAdapter,
} from "../vault";

describe("wikilink", () => {
  it("wraps a note name", () => expect(wikilink("Hub")).toBe("[[Hub]]"));
  it("adds an alias", () => expect(wikilink("Hub", "home")).toBe("[[Hub|home]]"));
  it("strips Obsidian-forbidden chars [ ] | # ^", () =>
    expect(wikilink("a[b]c|d#e^f")).toBe("[[abcdef]]"));
});

describe("frontmatter", () => {
  it("renders string, number and array fields deterministically", () => {
    expect(frontmatter({ type: "x", n: 3, tags: ["a", "b"] })).toBe(
      `---\ntype: "x"\nn: 3\ntags: ["a", "b"]\n---`,
    );
  });
});

describe("renderHub", () => {
  const args = {
    project: "Forge",
    updated: "2026-07-09",
    northStar: "one panel for every model",
    areas: [
      { note: "Engine", summary: "providers" },
      { note: "UI", summary: "chat" },
    ],
  };
  const out = renderHub(args);
  it("contains title, north star and injected date", () => {
    expect(out).toContain("# 🧭 Forge — Project Brain");
    expect(out).toContain("> North star: one panel for every model");
    expect(out).toContain("> Last updated: 2026-07-09");
  });
  it("links every area via a wikilink", () => {
    expect(out).toContain("- [[Engine]] — providers");
    expect(out).toContain("- [[UI]] — chat");
  });
  it("is deterministic (same input → byte-identical output, git-diff-stable)", () => {
    expect(renderHub(args)).toBe(out);
  });
});

describe("renderStatusNote", () => {
  it("renders status, bullets and a backlink to the hub", () => {
    const out = renderStatusNote({
      area: "Engine",
      updated: "2026-07-09",
      status: "green",
      bullets: ["14 providers", "cost-aware routing"],
      hub: "Forge — Project Brain",
    });
    expect(out).toContain("# Engine");
    expect(out).toContain("**Status:** green");
    expect(out).toContain("- 14 providers");
    expect(out).toContain("↩ [[Forge — Project Brain]]");
  });
});

describe("renderDecisionEntry", () => {
  it("renders without attribution", () =>
    expect(renderDecisionEntry({ date: "2026-07-09", title: "T", detail: "D" })).toBe(
      "### 2026-07-09 — T\nD\n",
    ));
  it("renders with the recording model as attribution", () =>
    expect(
      renderDecisionEntry({ date: "2026-07-09", title: "T", detail: "D", by: "haiku" }),
    ).toBe("### 2026-07-09 — T _(haiku)_\nD\n"));
});

describe("appendToDatedLog", () => {
  const older = renderDecisionEntry({ date: "2026-07-08", title: "Old", detail: "o" });
  const newer = renderDecisionEntry({ date: "2026-07-09", title: "New", detail: "n" });

  it("seeds an empty log with the heading", () => {
    const out = appendToDatedLog("", newer);
    expect(out.startsWith("# Decision & Change Log")).toBe(true);
    expect(out).toContain("### 2026-07-09 — New");
  });
  it("inserts newest-first under an existing heading", () => {
    const first = appendToDatedLog("", older);
    const second = appendToDatedLog(first, newer);
    expect(second.indexOf("New")).toBeLessThan(second.indexOf("Old"));
    // exactly one heading — not duplicated on append
    expect(second.match(/# Decision & Change Log/g)?.length).toBe(1);
  });
  it("prepends the heading when the existing content has none", () => {
    const out = appendToDatedLog("some prior freeform text", newer);
    expect(out.startsWith("# Decision & Change Log")).toBe(true);
    expect(out).toContain("some prior freeform text");
  });
});

describe("renderSkill / renderHabits", () => {
  it("renders a skill file with numbered steps", () => {
    const out = renderSkill({ name: "deploy", description: "d", when: "w", steps: ["a", "b"] });
    expect(out).toContain("# deploy");
    expect(out).toContain("**When to use:** w");
    expect(out).toContain("1. a");
    expect(out).toContain("2. b");
  });
  it("renders an evidence-cited habits profile", () => {
    const out = renderHabits({
      updated: "2026-07-09",
      modelPreferences: [{ taskType: "code", model: "opus", evidence: "3 wins" }],
      conventions: ["ts strict"],
      recurringIssues: [{ issue: "flaky test", count: 4 }],
    });
    expect(out).toContain("- **code** → opus _(3 wins)_");
    expect(out).toContain("- ts strict");
    expect(out).toContain("- flaky test — seen 4×");
  });
});

describe("MarkdownVault over an in-memory FsAdapter", () => {
  function memFs() {
    const store = new Map<string, string>();
    const fs: FsAdapter = {
      read: async (p) => store.get(p) ?? null,
      write: async (p, c) => {
        store.set(p, c);
      },
    };
    return { fs, store };
  }

  it("writes hub/status/skill/habits to their expected .md paths under root", async () => {
    const { fs, store } = memFs();
    const v = new MarkdownVault(fs, "vault");
    await v.writeHub({ project: "Forge", updated: "2026-07-09", northStar: "x", areas: [] });
    await v.writeStatus({ area: "Engine", updated: "2026-07-09", status: "green", bullets: [], hub: "Hub" });
    await v.writeSkill({ name: "deploy", description: "d", when: "w", steps: [] });
    await v.writeHabits({ updated: "2026-07-09", modelPreferences: [], conventions: [], recurringIssues: [] });
    expect(store.has("vault/🧭 Forge — Project Brain.md")).toBe(true);
    expect(store.has("vault/Engine.md")).toBe(true);
    expect(store.has("vault/skills/deploy.md")).toBe(true);
    expect(store.has("vault/Coding Habits.md")).toBe(true);
  });

  it("logDecision reads existing content and appends newest-first", async () => {
    const { fs, store } = memFs();
    const v = new MarkdownVault(fs);
    await v.logDecision({ date: "2026-07-08", title: "Old", detail: "o" });
    await v.logDecision({ date: "2026-07-09", title: "New", detail: "n" });
    const log = store.get("Decision & Change Log.md")!;
    expect(log.indexOf("New")).toBeLessThan(log.indexOf("Old"));
    expect(log.match(/# Decision & Change Log/g)?.length).toBe(1);
  });
});
