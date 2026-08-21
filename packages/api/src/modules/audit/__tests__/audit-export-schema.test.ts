import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Audit export completeness (BR-P1-005, roadmap §7.3: "Audit export bütün
 * actor/policy/action/result alanlarını kapsasın").
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS
 *
 *   - There is no `audit` module. The `export` module exports COMPANIES to
 *     Claude Code and has nothing to do with the audit trail.
 *   - ActivityLog carried actor, action, resource, resourceId, details, ip,
 *     createdAt — no `policy`, no `result`.
 *   - 130 call sites write it directly with no shared writer, and every one
 *     of them is on a SUCCESS path. A denied privileged attempt left no row
 *     at all, which is the moment a control most needs to produce evidence.
 *
 * "The export lists these four fields" would be a weak assertion: it stays
 * green forever while a fifth column is added that silently never leaves the
 * database. So this derives the field list from schema.prisma and requires
 * every scalar column to be either exported or omitted WITH A REASON. A new
 * column becomes a deliberate decision instead of a default.
 */

const SCHEMA = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "db", "prisma", "schema.prisma"),
  "utf8",
);

/** Prisma's built-in scalar types. */
const PRIMITIVES = new Set([
  "String", "Int", "Float", "Boolean", "DateTime", "Json", "Bytes", "Decimal", "BigInt",
]);

/** Every enum declared in the schema — enum-typed fields ARE columns. */
function enumNames(): Set<string> {
  return new Set([...SCHEMA.matchAll(/^\s*enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));
}

/** Every model declared in the schema — model-typed fields are relations. */
function modelNames(): Set<string> {
  return new Set([...SCHEMA.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map((m) => m[1]));
}

/**
 * Scalar (non-relation) field names on a Prisma model.
 *
 * An earlier version filtered by "type starts with a capital" and silently
 * DROPPED anything it could not place. Independent review proved it went
 * blind — and still reported zero missing columns — on an enum-typed field,
 * an uppercase-initial or underscore-initial field name, `Unsupported(...)`,
 * and a name/type split across lines. The enum case is not academic: `result`
 * holds three values and the obvious next refactor makes it an enum.
 *
 * So classification is now explicit and TOTAL: primitive or enum -> column,
 * model -> relation, anything else -> throw. A gate that cannot read its input
 * must fail, not pass; that rule is why the deploy-SSH gate caught its own
 * regression.
 */
function scalarFields(model: string): string[] {
  const m = SCHEMA.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`));
  expect(m, `model ${model} not found in schema.prisma`).toBeTruthy();

  const enums = enumNames();
  const models = modelNames();
  const out: string[] = [];

  for (const raw of m![1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    // A continuation line carrying only attributes belongs to the field above.
    if (line.startsWith("@")) continue;

    const parts = line.split(/\s+/);
    const [name, type] = parts;
    if (!/^[A-Za-z_]\w*$/.test(name)) {
      throw new Error(`${model}: cannot read field name in ${JSON.stringify(line)}`);
    }
    if (type === undefined) {
      throw new Error(`${model}: field "${name}" has no type on its line — this gate cannot classify it`);
    }

    const base = type.replace(/[\[\]?]/g, "");
    if (base.startsWith("Unsupported(")) { out.push(name); continue; }
    if (PRIMITIVES.has(base) || enums.has(base)) { out.push(name); continue; }
    if (models.has(base)) continue; // relation
    throw new Error(
      `${model}: field "${name}" has type "${type}", which is neither a Prisma scalar, ` +
        `a declared enum, nor a declared model. Refusing to guess.`,
    );
  }
  return out;
}

describe("audit export completeness (BR-P1-005)", () => {
  it("reads the model at all — a blind classifier must fail, not pass", () => {
    // Pinned exactly, like mount-order-invariant. Without it, a parser that
    // silently sees nothing makes every assertion below pass vacuously.
    expect(scalarFields("ActivityLog").length, "ActivityLog column count changed — update deliberately").toBe(11);
  });

  it("records the four fields the roadmap names", async () => {
    const fields = scalarFields("ActivityLog");
    for (const required of ["actor", "action", "result", "policy"]) {
      expect(fields, `ActivityLog must record "${required}"`).toContain(required);
    }
  });

  it("exports every column it stores, or names a reason for omitting it", async () => {
    const { AUDIT_EXPORT_FIELDS, AUDIT_EXPORT_OMITTED } = await import("../router");
    const declared = new Set<string>([...AUDIT_EXPORT_FIELDS, ...Object.keys(AUDIT_EXPORT_OMITTED)]);

    const missing = scalarFields("ActivityLog").filter((f) => !declared.has(f));
    expect(
      missing,
      `ActivityLog columns neither exported nor explicitly omitted: ${missing.join(", ")}. ` +
        `Add them to AUDIT_EXPORT_FIELDS, or to AUDIT_EXPORT_OMITTED with a reason.`,
    ).toEqual([]);
  });

  it("refuses a silent omission — every exclusion carries a written reason", async () => {
    const { AUDIT_EXPORT_OMITTED } = await import("../router");
    for (const [field, reason] of Object.entries(AUDIT_EXPORT_OMITTED)) {
      expect(typeof reason === "string" && reason.trim().length > 10, `omission of "${field}" needs a real reason`).toBe(true);
    }
  });

  it("does not claim to export a column that does not exist", async () => {
    const { AUDIT_EXPORT_FIELDS } = await import("../router");
    const actual = new Set(scalarFields("ActivityLog"));
    const phantom = AUDIT_EXPORT_FIELDS.filter((f: string) => !actual.has(f));
    expect(phantom, `exported fields with no backing column: ${phantom.join(", ")}`).toEqual([]);
  });
});
