/**
 * External-automation adapter normalisers — pure unit tests (no network).
 *
 * Covers the status vocabularies + record normalisation that turn each
 * platform's raw response into our NormalizedExecution shape. The fetch paths
 * themselves are thin (timeout + JSON parse) and exercised in integration; the
 * risk surface worth pinning is the mapping logic here.
 */
import { describe, it, expect } from "vitest";
import { assertPublicUrl } from "../adapters/types";
import { mapGenericStatus, toIso, normalizeGenericRecord } from "../adapters/generic";
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
  it("allows public https hosts", () => {
    expect(assertPublicUrl("https://eu1.make.com/api/v2/scenarios/1/logs").hostname).toBe("eu1.make.com");
  });
  it("refuses loopback / private / metadata hosts", () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      expect(() => assertPublicUrl(u)).toThrow();
    }
  });
});
