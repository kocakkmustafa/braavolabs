import { describe, expect, it } from "vitest";
import { DEEP_LINK_KINDS, DEEP_LINK_MAX_BYTES, buildDeepLink, deepLinkDataFor, parseDeepLink } from "./notificationDeepLink";

/** Birebir kopya: mobile/lib/notifications.ts:342-398 (SAFE_ID_PATTERN + resolveNotificationRoute). */
const SAFE = /^[a-zA-Z0-9_-]{1,64}$/;
const safeId = (x: unknown) => (typeof x === "string" && SAFE.test(x) ? x : null);
function mobileRoute(data: Record<string, unknown>): string | null {
  switch (data.kind) {
    case "approval": return "/(tabs)/approvals";
    case "risk": return "/risks";
    case "draft": return "/drafts";
    case "run": { const id = safeId(data.id); return id ? `/runs/${id}` : "/(tabs)/workflows"; }
    case "company": { const id = safeId(data.id); return id ? `/companies/${id}` : "/(tabs)/companies"; }
    default: return null;
  }
}

describe("notification deep link contract", () => {
  it("accepts every kind with and without ids and adds v:1", () => {
    for (const kind of DEEP_LINK_KINDS) {
      expect(buildDeepLink({ kind })).toEqual({ v: 1, kind });
      expect(buildDeepLink({ kind, id: "cmabc123_-X" })).toEqual({ v: 1, kind, id: "cmabc123_-X" });
    }
    expect(buildDeepLink({ kind: "approval", id: "a1", toolName: "gmail.send_email" }).kind).toBe("approval");
    expect(buildDeepLink({ kind: "risk", id: "r1", stopType: "cost_anomaly" }).kind).toBe("risk");
    expect(buildDeepLink({ kind: "draft", id: "d1", companyId: "c1" }).kind).toBe("draft");
  });

  it("rejects bad ids, extra fields, wrong version, unknown kinds, long values", () => {
    for (const id of ["../(auth)/login", "a b", "", "x".repeat(65), "é"]) expect(() => buildDeepLink({ kind: "run", id })).toThrow();
    expect(() => buildDeepLink({ kind: "run", id: "r1", body: "secret" })).toThrow();
    expect(() => buildDeepLink({ kind: "run", toolName: "x" })).toThrow();
    expect(() => buildDeepLink({ kind: "approval", toolName: "x".repeat(129) })).toThrow();
    expect(() => buildDeepLink({ kind: "inbox" as never })).toThrow();
    expect(parseDeepLink({ v: 2, kind: "run" })).toBeNull();
    expect(parseDeepLink({ kind: "run" })).toBeNull();
    expect(parseDeepLink({ v: 1, kind: "run", extra: 1 })).toBeNull();
    expect(parseDeepLink(null)).toBeNull();
    expect(parseDeepLink("run")).toBeNull();
  });

  it("round-trips through build -> JSON -> parse and the mobile resolver understands it", () => {
    const cases = [
      { kind: "approval" as const, id: "ap1", toolName: "gmail.send" },
      { kind: "risk" as const, id: "run1", stopType: "hard_stop" },
      { kind: "draft" as const, id: "dr1", companyId: "co1" },
      { kind: "run" as const, id: "run_9" },
      { kind: "company" as const, id: "co-2" },
      { kind: "run" as const },
    ];
    const routes = ["/(tabs)/approvals", "/risks", "/drafts", "/runs/run_9", "/companies/co-2", "/(tabs)/workflows"];
    cases.forEach((c, i) => {
      const wire = JSON.parse(JSON.stringify(buildDeepLink(c)));
      expect(parseDeepLink(wire)).toEqual({ v: 1, ...c });
      expect(mobileRoute(wire)).toBe(routes[i]);
    });
  });

  it("stays far below the APNs limit", () => {
    const max = buildDeepLink({ kind: "approval", id: "x".repeat(64), toolName: "t".repeat(128) });
    expect(Buffer.byteLength(JSON.stringify(max))).toBeLessThanOrEqual(DEEP_LINK_MAX_BYTES);
    expect(DEEP_LINK_MAX_BYTES).toBeLessThanOrEqual(1024);
  });

  it("lenient bridge keeps legacy fields, drops invalid and free-text fields (no PII leak)", () => {
    const r = deepLinkDataFor({ kind: "draft", id: "d1", companyId: "c1", title: "Jane Doe's salary", body: "secret", email: "a@b.co" });
    expect(r.data).toEqual({ v: 1, kind: "draft", id: "d1", companyId: "c1" });
    expect(r.dropped.sort()).toEqual(["body", "email", "title"]);
    const bad = deepLinkDataFor({ kind: "run", id: "../x" });
    expect(bad.data).toEqual({ v: 1, kind: "run" });
    expect(bad.dropped).toEqual(["id"]);
    expect(JSON.stringify(deepLinkDataFor({ kind: "approval", id: "a1", toolName: "Send mail to bob@x.com" }).data)).not.toContain("bob");
    expect(deepLinkDataFor({ kind: "risk" }).data).toEqual({ v: 1, kind: "risk" });
    // legacy payloads produced by today's callers
    expect(deepLinkDataFor({ kind: "approval", id: "a", toolName: "t.x" }).data).toEqual({ v: 1, kind: "approval", id: "a", toolName: "t.x" });
    expect(deepLinkDataFor({ kind: "risk", id: "r", stopType: "loop_guard" }).data).toEqual({ v: 1, kind: "risk", id: "r", stopType: "loop_guard" });
  });
});
