import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every read of the audit trail must name the columns it returns (BR-P1-005).
 *
 * WHY THIS EXISTS — found by independent review, and it falsified the whole
 * point of the audit export:
 *
 * `GET /api/v1/dashboard/activity?includeReads=1` returns the UNFILTERED
 * audit stream with no permission gate and no projection. So an ADMIN-gated
 * export stood next to an open door handing any MEMBER a SUPERSET of the same
 * data. Adding `result` and `policy` to ActivityLog widened that door for free:
 * Prisma returns every scalar from an un-projected findMany, so the new
 * columns became MEMBER-readable through ten readers that nobody touched.
 *
 * Once slice B starts recording denials, that would mean every MEMBER could
 * read who was refused what — including denials naming themselves.
 *
 * The completeness gate next door proves every column LEAVES through the
 * ADMIN export. This is its mirror: nothing leaves anywhere else by accident.
 * A new column is opt-in at every reader, not opt-out.
 *
 * SCOPE, so green is not misread: this proves a select EXISTS, never that it
 * is the RIGHT one. Choosing between the feed, revision and audit projections
 * stays a review question — and it bit once already, when /dashboard/risk-events
 * was narrowed to the feed while two UI panels rendered its `details`. This
 * gate was green throughout.
 */

const SRC = join(__dirname, "..");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__") continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(abs, acc);
    else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) acc.push(abs);
  }
  return acc;
}

/**
 * Reads of `activityLog`, with the balanced argument list that follows, so a
 * call split across lines (what Prettier produces past print width) is still
 * seen. A call whose arguments cannot be walked FAILS rather than being
 * skipped — a check that quietly stops seeing call sites is worse than none.
 */
function activityReads(text: string): Array<{ line: number; args: string; readable: boolean }> {
  const out: Array<{ line: number; args: string; readable: boolean }> = [];
  const call = /\bactivityLog\s*\.\s*(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push({
      line: text.slice(0, m.index).split("\n").length,
      args: text.slice(start, i - 1),
      readable: depth === 0,
    });
  }
  return out;
}

describe("audit-trail reads are projected (BR-P1-005)", () => {
  const files = sourceFiles(SRC);

  it("finds the readers at all — a blind gate must fail, not pass", () => {
    const total = files.reduce((n, f) => n + activityReads(readFileSync(f, "utf8")).length, 0);
    // Pinned exactly, like mount-order-invariant. If the parser goes blind
    // every assertion below passes vacuously. Update deliberately.
    // 11 -> 12: the audit export's tenant-scoped cursor anchor (findFirst),
    // added to replace Prisma's untenanted cursor sub-select.
    expect(total, "activityLog read-site count changed — update deliberately").toBe(12);
  });

  it("names the columns at every read site", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const { line, args, readable } of activityReads(text)) {
        const rel = f.slice(SRC.length + 1);
        if (!readable) {
          offenders.push(`${rel}:${line} arguments could not be parsed — refusing to skip it`);
          continue;
        }
        if (!/\bselect\s*:/.test(args)) {
          offenders.push(
            `${rel}:${line} reads activity_log with no select — every future column ` +
              `leaks through it automatically`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
