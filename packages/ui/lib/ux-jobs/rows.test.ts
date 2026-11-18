import { describe, it, expect } from "vitest";
import { approvalRisk, riskKey, stateKey, verificationKey } from "./rows";
import { uxJobsEnabled, UX_JOBS_ENV } from "./flag";
import type { InboxRun } from "../inbox";

const run = (over: Partial<InboxRun>): InboxRun => ({
  id: "r", pipelineId: "p", status: "RUNNING", state: "RUNNING", resultStatus: null, createdAt: "2026-11-11T09:00:00Z", updatedAt: "2026-11-11T09:00:00Z", bucket: "working", ...over,
});

describe("bayrak NEXT_PUBLIC_UX_JOBS", () => {
  it("adı sabit; yalnız 1/true (büyük küçük harf, boşluk toleranslı) açar", () => {
    expect(UX_JOBS_ENV).toBe("NEXT_PUBLIC_UX_JOBS");
    for (const v of ["1", "true", "TRUE", " True ", "  1"]) expect(uxJobsEnabled({ [UX_JOBS_ENV]: v })).toBe(true);
    for (const v of ["0", "false", "", "yes", "on", "2", undefined]) expect(uxJobsEnabled({ [UX_JOBS_ENV]: v })).toBe(false);
  });
  it("varsayılan KAPALI (ortamda yoksa)", () => {
    expect(uxJobsEnabled({})).toBe(false);
  });
  it("diğer bayraklar İşler'i açmaz", () => {
    expect(uxJobsEnabled({ NEXT_PUBLIC_UX_LAB: "1", NEXT_PUBLIC_UX_INTENT: "1" })).toBe(false);
  });
});

describe("durum etiketi anahtarı", () => {
  it("bilinen durumlar kendi anahtarına gider", () => {
    expect(stateKey(run({ state: "RUNNING" }))).toBe("app.jobs.state.RUNNING");
    expect(stateKey(run({ state: "NEEDS_APPROVAL", status: "WAITING_APPROVAL" }))).toBe("app.jobs.state.NEEDS_APPROVAL");
    expect(stateKey(run({ state: "COMPLETED", status: "COMPLETED" }))).toBe("app.jobs.state.COMPLETED");
  });
  it("state yoksa eski status'tan türetilir; hiçbiri yoksa 'unknown' (uydurma yok)", () => {
    expect(stateKey(run({ state: null, status: "COMPLETED" }))).toBe("app.jobs.state.COMPLETED");
    expect(stateKey(run({ state: null, status: "GARIP_DURUM" }))).toBe("app.jobs.state.unknown");
  });
});

describe("risk", () => {
  it("yalnız low/medium/high tanınır; diğer her şey null", () => {
    expect(riskKey("low")).toBe("low");
    expect(riskKey("medium")).toBe("medium");
    expect(riskKey("high")).toBe("high");
    for (const v of [undefined, null, "", "HIGH", "critical", 3, {}]) expect(riskKey(v)).toBeNull();
  });
  it("onay riski details.risk'ten gelir; details yoksa null ('düşük' varsayılmaz)", () => {
    expect(approvalRisk({ details: { risk: "medium" } })).toBe("medium");
    expect(approvalRisk({ details: null })).toBeNull();
    expect(approvalRisk({})).toBeNull();
  });
});

describe("doğrulama etiketi", () => {
  it("VERIFIED / UNVERIFIED / bilgi yok", () => {
    expect(verificationKey({ resultStatus: "VERIFIED" })).toBe("verified");
    expect(verificationKey({ resultStatus: "UNVERIFIED" })).toBe("unverified");
    expect(verificationKey({ resultStatus: null })).toBe("noVerification");
  });
});
