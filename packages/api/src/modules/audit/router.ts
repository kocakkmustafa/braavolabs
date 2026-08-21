/**
 * Audit export (BR-P1-005, roadmap §7.3).
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS
 *
 *   - There was no audit module. The `export` module exports COMPANIES to
 *     Claude Code and has nothing to do with the audit trail, so "we have an
 *     export" was true of a completely different thing.
 *   - ActivityLog had no `policy` and no `result`.
 *   - 130 call sites write it directly, with no shared writer, and all of them
 *     sit on success paths — a denied privileged attempt left no row at all.
 *
 * This is slice A: the read side. The write side (a single chokepoint that
 * records denials) is slice B; until it lands, `result`/`policy` are present
 * and honest-but-mostly-null rather than absent.
 */
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { requirePermission } from "../../middleware/require-permission";
import { prisma } from "../../lib/db";
import { rateLimit } from "../../middleware/rateLimit";
import { logger } from "../../lib/logger";

/**
 * The exported projection.
 *
 * Kept as a value, not an inline `select`, because a test derives the
 * ActivityLog column list from schema.prisma and asserts every column is
 * either here or in AUDIT_EXPORT_OMITTED. A column added later cannot
 * silently stay inside the database.
 */
export const AUDIT_EXPORT_FIELDS = [
  "id",
  "createdAt",
  "actor",
  "action",
  "resource",
  "resourceId",
  "result",
  "policy",
  "ip",
  "details",
] as const;

/**
 * Columns deliberately NOT exported, each with the reason.
 *
 * An omission with no reason is indistinguishable from an oversight, so the
 * test rejects an empty one.
 */
/**
 * When `result`/`policy` began being recorded. NULL until the slice-B
 * chokepoint ships — stated in the payload rather than in a code comment the
 * auditor never sees.
 */
export const RESULT_COVERAGE_SINCE: string | null = null;

export const AUDIT_EXPORT_OMITTED: Record<string, string> = {
  tenantId:
    "implicit — the export is scoped to the caller's tenant, so repeating it on every " +
    "row adds no information and invites a reader to think it is a filter they can change",
};

/** Hard ceiling on a page. A caller-supplied limit narrows it, never widens it. */
export const AUDIT_MAX_PAGE = 1000;
const DEFAULT_PAGE = 200;

export const auditRouter = Router();
auditRouter.use(authMiddleware);

/** A bad parameter on an AUDIT artifact must be refused, never reinterpreted. */
class BadFilter extends Error {
  statusCode = 400;
}

/**
 * Parse a caller-supplied timestamp.
 *
 * Silently dropping an unparseable date is wrong HERE in a way it would not be
 * on a search endpoint: an auditor who typos a date would receive the entire
 * table with no signal that their filter was discarded, and would reasonably
 * read the result as "this is what happened in that window".
 */
function parseInstant(raw: unknown, name: string): Date | undefined {
  if (raw === undefined || raw === "") return undefined;
  // A non-string here is `?from[]=a&from[]=b` or `?to[x][y]=1`. Returning
  // undefined for those made this parser do the exact thing the paragraph
  // above says it must not: discard the filter and hand back the whole table
  // with no signal. Refuse instead.
  if (typeof raw !== "string") throw new BadFilter(`Invalid ${name}: expected a single value`);
  if (raw.length > MAX_FILTER_LENGTH) throw new BadFilter(`Invalid ${name}: value too long`);
  // JS parses bare numerics as years: `0` -> 1999-12-31, `1` -> 2000-12-31,
  // `10000-01-01` -> 9999-12-31 (V8 clamps it, which is how it slipped past
  // the range check below). Each is a REAL date, so nothing errors — the
  // filter is simply not the one the caller asked for, on the endpoint whose
  // premise is that a bad parameter is refused rather than reinterpreted.
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw)) {
    throw new BadFilter(`Invalid ${name}: expected an ISO-8601 timestamp`);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadFilter(`Invalid ${name}: expected an ISO-8601 timestamp`);
  // Valid to JS, rejected by Postgres. `+275760-09-13` and `-271821-04-20`
  // are the max and min Date, so `Number.isNaN` passes and the value went
  // straight into the query — which came back 500 with a raw Prisma error in
  // the body. On the endpoint whose premise is "a bad parameter must be
  // refused, never reinterpreted", a caller-controlled 500 is that premise
  // failing.
  const year = d.getUTCFullYear();
  if (year < 1970 || year > 9999) {
    throw new BadFilter(`Invalid ${name}: year out of range`);
  }
  return d;
}

/** Parse the page size. `1e9` must not quietly become 1. */
function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === "") return DEFAULT_PAGE;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new BadFilter("Invalid limit: expected a positive integer");
  }
  const n = Number.parseInt(raw, 10);
  if (n <= 0) throw new BadFilter("Invalid limit: expected a positive integer");
  return Math.min(n, AUDIT_MAX_PAGE);
}

/** A single string query param, or undefined. Arrays/objects are refused. */
const MAX_FILTER_LENGTH = 200;

function parseScalar(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadFilter(`Invalid ${name}: expected a single value`);
  // Length, not just shape. These values are echoed into the self-audit row,
  // so an unbounded one is attacker-chosen bytes written into the trail:
  // review pushed 1671 bytes through `actor` against a ~873-byte baseline.
  // No real actor id or result token approaches this.
  if (raw.length > MAX_FILTER_LENGTH) throw new BadFilter(`Invalid ${name}: value too long`);
  return raw === "" ? undefined : raw;
}

/**
 * GET /api/v1/audit/export
 *
 * Query: limit, cursor (row id), from, to (ISO timestamps), result, actor.
 */
auditRouter.get(
  "/export",
  requirePermission("audit:export"),
  // The trail this drains is projected at ~180M rows/year and a page is 1000
  // rows. Without a bucket, one hour-long ADMIN token drains the lot.
  //
  // Scope of the protection, honestly: `rl:audit-export` is in the limiter's
  // fail-CLOSED list, so a Redis outage refuses exports rather than removing
  // the ceiling. And the ceiling is deliberately generous enough to be
  // usable — a real auditor exports a window, not all of history.
  rateLimit({ windowMs: 60_000, maxRequests: 30, keyPrefix: "rl:audit-export" }),
  async (req, res, next) => {
    try {
      const tenantId = req.auth!.tenantId;
      const take = parseLimit(req.query.limit);

      // Every filter is built from named, individually parsed params. Caller
      // input is never spread into `where`, so `?tenantId=` and
      // `?where[tenantId]=` are inert: tenant scope is not a filter the
      // caller participates in.
      const where: Record<string, unknown> = { tenantId };

      const from = parseInstant(req.query.from, "from");
      const to = parseInstant(req.query.to, "to");
      const range: Record<string, Date> = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
      if (Object.keys(range).length > 0) where.createdAt = range;

      const result = parseScalar(req.query.result, "result");
      if (result) where.result = result;
      const actor = parseScalar(req.query.actor, "actor");
      if (actor) where.actor = actor;

      const cursor = parseScalar(req.query.cursor, "cursor");
      if (cursor) {
        // Prisma's `cursor` + `skip: 1` is a blind OFFSET, not "exclude this
        // id". Two defects came out of that, both proven by review against a
        // real database:
        //
        //   - the cursor sub-select is NOT tenant-filtered, so the row COUNT
        //     became a monotone oracle for a foreign row's timestamp — and
        //     RLS does not save us, because the production role still holds
        //     BYPASSRLS until STAGE 2 is activated;
        //   - when the cursor row is not in the filtered set (a narrowed
        //     filter, or the row aged out under retention), OFFSET 1 silently
        //     drops one legitimate row and still returns 200. A quietly-short
        //     audit trail is the single failure an audit artifact must not have.
        //
        // So the anchor is resolved WITHIN the tenant, and paging is an
        // explicit keyset predicate over the same ordering.
        const anchor = await prisma.activityLog.findFirst({
          where: { id: cursor, tenantId },
          select: { id: true, createdAt: true },
        });
        if (!anchor) throw new BadFilter("Unknown cursor");
        where.OR = [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ];
      }

      const rows = await prisma.activityLog.findMany({
        where,
        // One extra row to learn whether another page exists, without a COUNT
        // over a table growing ~180M rows/year.
        take: take + 1,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: Object.fromEntries(AUDIT_EXPORT_FIELDS.map((f) => [f, true])),
      });

      const hasMore = rows.length > take;
      const page = hasMore ? rows.slice(0, take) : rows;

      // A successful export must appear in the trail it exports, and this
      // gives slice A its first non-null result/policy pair.
      //
      // HALF the gap, stated plainly: a DENIED export still writes nothing,
      // because `requirePermission` returns 403 before this handler runs.
      // Recording refusals is the slice-B chokepoint and is NOT done here.
      await prisma.activityLog
        .create({
          data: {
            tenantId,
            actor: req.auth!.userId,
            action: "audit.export",
            resource: "activity_log",
            ip: req.ip ?? null,
            result: "allowed",
            policy: "audit:export",
            // PARSED values, never the raw query. Recording `req.query.from`
            // wrote whatever the caller sent — the one input that had not
            // been validated — straight into the trail; review pushed a
            // 1282-byte attacker-chosen blob through it against rows that
            // normally run 77-87 bytes.
            details: {
              rowCount: page.length,
              filters: {
                from: from?.toISOString() ?? null,
                to: to?.toISOString() ?? null,
                result: result ?? null,
                actor: actor ?? null,
              },
            },
          },
        })
        .catch((err: unknown) => {
          // Never fail the caller's export because the record of it failed,
          // but never let that failure be silent either.
          logger.error({ err, tenantId }, "failed to record audit.export in the activity log");
        });

      res.json({
        rows: page,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        // The artifact carries its own caveat. `result`/`policy` are NULL for
        // every row written before the denial-recording chokepoint (slice B)
        // exists, and an auditor reading raw JSON cannot otherwise tell
        // "never evaluated" from "evaluated and not recorded".
        resultCoverageSince: RESULT_COVERAGE_SINCE,
      });
    } catch (err) {
      next(err);
    }
  },
);
