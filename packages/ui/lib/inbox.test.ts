import { describe, it, expect } from "vitest";
import { INBOX_BUCKETS, jobBucket } from "@ai-company-os/core";
import {
  INBOX_TABS, tabFromValue, nextTabIndex, mergeById, mergeApprovalGroups,
  allowedActions, actionErrorKey, parseRunsPage, parseApprovalGroupsPage, cursorFromHeaders, InboxShapeError, receiptVerified, effectiveState, CONFLICT_CODES,
} from "./inbox";
import { ApiRequestError } from "./api";
import { readFileSync } from "node:fs";

describe("bucket tabs (core sözleşmesi)", () => {
  it("sekmeler core INBOX_BUCKETS ile birebir aynı ve aynı sırada", () => {
    expect([...INBOX_TABS]).toEqual([...INBOX_BUCKETS]);
    expect(INBOX_TABS).toEqual(["working", "needs_approval", "done", "stuck"]);
  });
  it("bilinmeyen değer ilk sekmeye düşer", () => {
    expect(tabFromValue("stuck")).toBe("stuck");
    expect(tabFromValue("nope")).toBe("working");
    expect(tabFromValue(undefined)).toBe("working");
  });
  it("jobBucket çıktısı her zaman bir sekmedir (DRAFT hariç)", () => {
    const now = Date.now();
    for (const status of ["PENDING", "RUNNING", "PAUSED", "WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"]) {
      expect(INBOX_TABS).toContain(jobBucket({ status, now, staleAfterMs: 1000 })!);
    }
  });
});

describe("nextTabIndex (klavye)", () => {
  it("ok tuşları çevrel, Home/End uçlara gider, diğer tuşlar null", () => {
    expect(nextTabIndex("ArrowRight", 3, 4)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(nextTabIndex("Home", 2, 4)).toBe(0);
    expect(nextTabIndex("End", 0, 4)).toBe(3);
    expect(nextTabIndex("a", 0, 4)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
  it("RTL'de yatay yön tersine döner", () => {
    expect(nextTabIndex("ArrowLeft", 0, 4, true)).toBe(1);
    expect(nextTabIndex("ArrowRight", 0, 4, true)).toBe(3);
  });
});

describe("cursor birleştirme", () => {
  it("mergeById çift satırı atar, sırayı korur", () => {
    expect(mergeById([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  it("mergeApprovalGroups bölünmüş koşu grubunu birleştirir ve girdiyi değiştirmez", () => {
    const ap = (id: string, runId: string) => ({ id, runId, status: "PENDING", createdAt: "x" });
    const a = [{ runId: "r1", runTitle: "P", approvals: [ap("1", "r1")] }];
    const b = [{ runId: "r1", runTitle: "P", approvals: [ap("1", "r1"), ap("2", "r1")] }, { runId: "r2", runTitle: null, approvals: [ap("3", "r2")] }];
    const m = mergeApprovalGroups(a, b);
    expect(m.map((g) => [g.runId, g.approvals.length])).toEqual([["r1", 2], ["r2", 1]]);
    expect(a[0].approvals).toHaveLength(1);
  });
});

describe("allowedActions", () => {
  it("duruma göre yalnız izinli eylemler", () => {
    expect(allowedActions({ state: "PAUSED", status: "PAUSED", bucket: "stuck" })).toEqual(["resume", "retry", "steer", "stop"]);
    expect(allowedActions({ state: null, status: "FAILED", bucket: "stuck" })).toEqual(["retry"]);
    expect(allowedActions({ state: "RUNNING", status: "RUNNING", bucket: "working" })).toEqual(["steer", "pause", "stop"]);
    expect(allowedActions({ state: "RUNNING", status: "RUNNING", bucket: "stuck" })).toEqual(["stop"]);
    expect(allowedActions({ state: null, status: "COMPLETED", bucket: "done" })).toEqual([]);
  });
  it("onay bekleyende resume yok (karar /approvals'tan)", () => {
    expect(allowedActions({ state: null, status: "WAITING_APPROVAL", bucket: "needs_approval" })).not.toContain("resume");
  });
  it("state status'u ezer; bilinmeyen durum eylemsiz", () => {
    expect(effectiveState({ state: "FAILED", status: "RUNNING" })).toBe("FAILED");
    expect(allowedActions({ state: null, status: "???", bucket: "stuck" })).toEqual([]);
  });
});

describe("409 → mesaj anahtarı", () => {
  it("altı sunucu kodu kendi anahtarına gider", () => {
    for (const code of CONFLICT_CODES) expect(actionErrorKey(new ApiRequestError(409, "x", code))).toBe(`app.inbox.conflict.${code}`);
  });
  it("kodsuz/bilinmeyen 409 genel, 403 yetki, diğerleri genel hata", () => {
    expect(actionErrorKey(new ApiRequestError(409, "x"))).toBe("app.inbox.conflict.generic");
    expect(actionErrorKey(new ApiRequestError(409, "x", "other"))).toBe("app.inbox.conflict.generic");
    expect(actionErrorKey(new ApiRequestError(403, "x"))).toBe("app.inbox.actionForbidden");
    expect(actionErrorKey(new Error("boom"))).toBe("app.inbox.actionFailed");
    expect(actionErrorKey(null)).toBe("app.inbox.actionFailed");
  });
  it("her anahtar tr ve en mesajlarında var", () => {
    for (const lang of ["tr", "en"]) {
      const m = JSON.parse(readFileSync(new URL(`../messages/${lang}.json`, import.meta.url), "utf8")).app.inbox;
      for (const code of CONFLICT_CODES) expect(m.conflict[code]).toBeTruthy();
    }
  });
});

describe("receipt", () => {
  it("VERIFIED / UNVERIFIED / null ayrımı", () => {
    expect(receiptVerified({ resultStatus: "VERIFIED" })).toBe(true);
    expect(receiptVerified({ resultStatus: "UNVERIFIED" })).toBe(false);
    expect(receiptVerified({ resultStatus: null })).toBeNull();
  });
});

describe("yanıt şekli (sessiz boş liste yok)", () => {
  it("GET /runs gövde { runs, nextCursor } kabul; düz dizi/başlık-only şekli fırlatır", () => {
    const run = { id: "r1", status: "RUNNING", state: null, bucket: "working" };
    expect(parseRunsPage({ runs: [run], nextCursor: "abc" }).nextCursor).toBe("abc");
    expect(parseRunsPage({ runs: [], nextCursor: null })).toEqual({ runs: [], nextCursor: null });
    expect(() => parseRunsPage([run])).toThrow(InboxShapeError);
    expect(() => parseRunsPage({})).toThrow(InboxShapeError);
    expect(() => parseRunsPage({ runs: [{}] })).toThrow(InboxShapeError);
    expect(() => parseRunsPage({ runs: [], nextCursor: 5 })).toThrow(InboxShapeError);
  });
  it("groupBy=run gövde { groups, nextCursor }; düz dizi fırlatır", () => {
    const g = { runId: "r1", runTitle: "P", approvals: [{ id: "a1" }] };
    expect(parseApprovalGroupsPage({ groups: [g], nextCursor: null }).groups).toHaveLength(1);
    expect(() => parseApprovalGroupsPage([{ id: "a1" }])).toThrow(InboxShapeError);
    expect(() => parseApprovalGroupsPage({ groups: [{ runId: "r" }] })).toThrow(InboxShapeError);
  });
  it("düz approvals modunda imleç X-Next-Cursor başlığından", () => {
    expect(cursorFromHeaders(new Headers({ "X-Next-Cursor": "zz" }))).toBe("zz");
    expect(cursorFromHeaders(new Headers())).toBeNull();
  });
});
