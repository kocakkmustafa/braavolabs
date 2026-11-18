/**
 * BRA-P0-04b — bucketWhere (SQL tarafı) ile jobBucket() (core) tutarlılığı.
 * Prisma where alt kümesini (AND/OR/eşitlik/in/null/gte/lt) bellekte değerlendirip
 * state x status x kalp atışı matrisinde jobBucket ile karşılaştırır.
 */
import { describe, it, expect, afterEach } from "vitest";
import { INBOX_BUCKETS, JOB_STATES, LEGACY_RUN_STATUS_VALUES, jobBucket, type InboxBucket } from "@ai-company-os/core";
import { bucketWhere, isInboxBucket, jobStaleAfterMs, DEFAULT_JOB_STALE_AFTER_MS } from "../job-bucket-query";
import { decodeCursor, encodeCursor, parseLimit, afterCursorWhere } from "../list-cursor";

type Row = Record<string, any>;

function cond(v: unknown, cnd: any): boolean {
  if (cnd !== null && typeof cnd === "object" && !(cnd instanceof Date)) {
    if ("in" in cnd) return cnd.in.includes(v);
    if ("gte" in cnd) return v instanceof Date && v.getTime() >= cnd.gte.getTime();
    if ("lt" in cnd) return v instanceof Date && v.getTime() < cnd.lt.getTime();
    throw new Error("unsupported operator " + JSON.stringify(cnd));
  }
  if (cnd instanceof Date) return v instanceof Date && v.getTime() === cnd.getTime();
  return v === cnd;
}

function matches(row: Row, where: any): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    return cond(row[k], v);
  });
}

const NOW = new Date("2026-11-09T12:00:00.000Z");
const STALE = 15 * 60_000;
const heartbeats: Array<Date | null> = [
  null,
  new Date(NOW.getTime() - 60_000),
  new Date(NOW.getTime() - STALE), // sınırda: bayat DEĞİL (n - hb > eşik)
  new Date(NOW.getTime() - STALE - 1),
];

function rows(): Row[] {
  const out: Row[] = [];
  const statuses = [...LEGACY_RUN_STATUS_VALUES];
  for (const heartbeatAt of heartbeats) {
    for (const status of statuses) {
      out.push({ state: null, status, heartbeatAt });
      for (const state of JOB_STATES) out.push({ state, status, heartbeatAt });
    }
  }
  return out;
}

describe("bucketWhere ile jobBucket tutarlı", () => {
  const all = rows();
  for (const bucket of INBOX_BUCKETS) {
    it(`bucket=${bucket}: where eşleşmesi == jobBucket sonucu (${all.length} satır)`, () => {
      const where = bucketWhere(bucket, NOW, STALE);
      for (const r of all) {
        const expected = jobBucket({ ...r, now: NOW, staleAfterMs: STALE } as any) === bucket;
        expect(matches(r, where), JSON.stringify(r)).toBe(expected);
      }
    });
  }

  it("bucket yok: DRAFT hariç hepsi; jobBucket null olanlar dışarıda", () => {
    const where = bucketWhere(undefined, NOW, STALE);
    for (const r of all) {
      const expected = jobBucket({ ...r, now: NOW, staleAfterMs: STALE } as any) !== null;
      expect(matches(r, where), JSON.stringify(r)).toBe(expected);
    }
  });

  it("state doluysa status yok sayılır (RUNNING state + COMPLETED status = working)", () => {
    const r = { state: "RUNNING", status: "COMPLETED", heartbeatAt: null };
    expect(matches(r, bucketWhere("working", NOW, STALE))).toBe(true);
    expect(matches(r, bucketWhere("done", NOW, STALE))).toBe(false);
  });
});

describe("yardımcılar", () => {
  afterEach(() => { delete process.env.JOB_HEARTBEAT_STALE_MS; });

  it("isInboxBucket", () => {
    expect(isInboxBucket("working")).toBe(true);
    expect(isInboxBucket("all")).toBe(false);
    expect(isInboxBucket(undefined)).toBe(false);
  });

  it("jobStaleAfterMs: varsayılan 15 dk, env ile ayarlanır, geçersiz değer varsayılana düşer", () => {
    expect(jobStaleAfterMs()).toBe(DEFAULT_JOB_STALE_AFTER_MS);
    expect(DEFAULT_JOB_STALE_AFTER_MS).toBe(900_000);
    process.env.JOB_HEARTBEAT_STALE_MS = "60000";
    expect(jobStaleAfterMs()).toBe(60_000);
    process.env.JOB_HEARTBEAT_STALE_MS = "abc";
    expect(jobStaleAfterMs()).toBe(DEFAULT_JOB_STALE_AFTER_MS);
    process.env.JOB_HEARTBEAT_STALE_MS = "-5";
    expect(jobStaleAfterMs()).toBe(DEFAULT_JOB_STALE_AFTER_MS);
  });

  it("imleç gidiş-dönüş ve bozuk imleçler", () => {
    const row = { createdAt: new Date("2026-11-09T10:00:00.123Z"), id: "run-9" };
    const c = decodeCursor(encodeCursor(row));
    expect(c).toEqual(row);
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-json!!")).toBeNull();
    expect(decodeCursor(Buffer.from('{"c":"yarın","i":"x"}').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"c":"2026-11-09T10:00:00.000Z"}').toString("base64url"))).toBeNull();
    expect(decodeCursor(["a"])).toBeNull();
    expect(afterCursorWhere(row)).toEqual({
      OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: "run-9" } }],
    });
  });

  it("parseLimit", () => {
    expect(parseLimit(undefined, 25)).toBe(25);
    expect(parseLimit("1", 25)).toBe(1);
    expect(parseLimit("100", 25)).toBe(100);
    for (const bad of ["0", "101", "-1", "1.5", "abc", "", ["5"]]) expect(parseLimit(bad, 25)).toBeNull();
  });
});

export type _Unused = InboxBucket;
