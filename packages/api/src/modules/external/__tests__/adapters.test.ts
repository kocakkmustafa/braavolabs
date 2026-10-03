/**
 * External-automation adapter normalisers — pure unit tests (no network).
 *
 * Covers the status vocabularies + record normalisation that turn each
 * platform's raw response into our NormalizedExecution shape. The fetch paths
 * themselves are thin (timeout + JSON parse) and exercised in integration; the
 * risk surface worth pinning is the mapping logic here.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { assertPublicUrl } from "../adapters/types";
import { mapGenericStatus, toIso, normalizeGenericRecord, pickArray } from "../adapters/generic";
import { mapMakeStatus } from "../adapters/make";

describe("mapGenericStatus", () => {
  it("maps running-ish vocab", () => {
    for (const s of ["running", "in_progress", "started", "new", "waiting", "queued", "active"]) {
      expect(mapGenericStatus(s)).toBe("RUNNING");
    }
  });
  it("maps completed-ish vocab (incl. truthy)", () => {
    for (const s of ["success", "succeeded", "completed", "ok", "done", "finished", "true", "1"]) {
      expect(mapGenericStatus(s)).toBe("COMPLETED");
    }
  });
  it("maps failure + cancellation vocab", () => {
    for (const s of ["error", "failed", "crashed", "false"]) expect(mapGenericStatus(s)).toBe("FAILED");
    for (const s of ["canceled", "cancelled", "aborted", "stopped", "skipped"]) expect(mapGenericStatus(s)).toBe("CANCELLED");
  });
  it("is case/whitespace insensitive and defaults to PENDING", () => {
    expect(mapGenericStatus("  SUCCESS ")).toBe("COMPLETED");
    expect(mapGenericStatus(undefined)).toBe("PENDING");
    expect(mapGenericStatus("banana")).toBe("PENDING");
  });
});

describe("toIso", () => {
  it("coerces epoch seconds and millis", () => {
    expect(toIso(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(toIso(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
  });
  it("passes through ISO strings and rejects junk", () => {
    expect(toIso("2026-06-01T10:00:00.000Z")).toBe("2026-06-01T10:00:00.000Z");
    expect(toIso("not-a-date")).toBeUndefined();
    expect(toIso(null)).toBeUndefined();
  });
});

describe("normalizeGenericRecord", () => {
  it("uses an explicit id and maps aliased fields", () => {
    const r = normalizeGenericRecord({ id: 42, name: "Lead sync", state: "succeeded", created_at: "2026-06-01T10:00:00Z" })!;
    expect(r.externalId).toBe("42");
    expect(r.workflowName).toBe("Lead sync");
    expect(r.status).toBe("COMPLETED");
    expect(r.startedAt).toBe("2026-06-01T10:00:00.000Z");
  });
  it("derives a deterministic key when no id is present", () => {
    const rec = { title: "Nightly", timestamp: "2026-06-01T09:00:00Z", outcome: "error" };
    const a = normalizeGenericRecord(rec)!;
    const b = normalizeGenericRecord(rec)!;
    expect(a.externalId).toBe(b.externalId); // stable across polls → upsert, not duplicate
    expect(a.status).toBe("FAILED");
  });
  it("skips records with nothing stable to key on", () => {
    expect(normalizeGenericRecord({ status: "ok" })).toBeNull();
  });
});

describe("mapMakeStatus", () => {
  it("maps Make scenario-log outcomes", () => {
    expect(mapMakeStatus({ status: "success" })).toBe("COMPLETED");
    expect(mapMakeStatus({ status: "error" })).toBe("FAILED");
    expect(mapMakeStatus({ type: "warning" })).toBe("FAILED");
    expect(mapMakeStatus({ status: "incomplete" })).toBe("RUNNING");
    expect(mapMakeStatus({ status: "" })).toBe("PENDING");
  });
});

describe("assertPublicUrl (shared SSRF guard)", () => {
  beforeEach(() => {
    dns.lookup.mockReset();
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("allows public https hosts", async () => {
    const url = await assertPublicUrl("https://eu1.make.com/api/v2/scenarios/1/logs");
    expect(url.hostname).toBe("eu1.make.com");
    expect(dns.lookup).toHaveBeenCalledExactlyOnceWith("eu1.make.com", { all: true });
  });
  it("refuses a hostname that resolves to a private address", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }]);
    await expect(assertPublicUrl("https://automation.example.invalid/hooks")).rejects.toThrow();
    expect(dns.lookup).toHaveBeenCalledOnce();
  });
  it("refuses mixed public and private DNS answers", async () => {
    dns.lookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(assertPublicUrl("https://automation.example.invalid/hooks")).rejects.toThrow();
    expect(dns.lookup).toHaveBeenCalledOnce();
  });
  it("refuses a hostname when DNS resolution fails", async () => {
    dns.lookup.mockRejectedValueOnce(new Error("Synthetic DNS lookup failure"));
    await expect(assertPublicUrl("https://automation.example.invalid/hooks"))
      .rejects.toThrow("Hostname does not resolve");
    expect(dns.lookup).toHaveBeenCalledOnce();
  });
  it("refuses loopback / private / metadata hosts", async () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      await expect(assertPublicUrl(u)).rejects.toThrow();
    }
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});

describe("pickArray (defensive response-shape extraction)", () => {
  it("returns a bare array as-is", () => {
    expect(pickArray([1, 2], ["executions"])).toEqual([1, 2]);
  });
  it("finds the first listed key whose value is an array", () => {
    expect(pickArray({ data: [{ id: 1 }] }, ["executions", "runs", "data"])).toEqual([{ id: 1 }]);
    expect(pickArray({ scenarioLogs: [{ imt_id: 9 }] }, ["scenarioLogs", "data"])).toEqual([{ imt_id: 9 }]);
  });
  it("ignores a present-but-non-array key (guards .slice crash)", () => {
    expect(pickArray({ executions: 5 }, ["executions", "runs"])).toEqual([]);
    expect(pickArray({ runs: { nope: true } }, ["runs"])).toEqual([]);
  });
  it("returns [] for null / string / number / empty bodies", () => {
    for (const b of [null, undefined, "oops", 42, {}]) {
      expect(pickArray(b as unknown, ["executions", "runs", "data"])).toEqual([]);
    }
  });
});

describe("normalizeGenericRecord — more edge cases", () => {
  it("maps boolean `finished` truthy to COMPLETED", () => {
    const r = normalizeGenericRecord({ id: "x1", finished: true })!;
    expect(r.status).toBe("COMPLETED");
  });
  it("coerces epoch-seconds startedAt to ISO", () => {
    const r = normalizeGenericRecord({ id: "x2", timestamp: 1_700_000_000 })!;
    expect(r.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
  it("uses uuid/runId aliases for the external id", () => {
    expect(normalizeGenericRecord({ uuid: "abc", status: "ok" })!.externalId).toBe("abc");
    expect(normalizeGenericRecord({ run_id: "r9", state: "running" })!.externalId).toBe("r9");
  });
});
