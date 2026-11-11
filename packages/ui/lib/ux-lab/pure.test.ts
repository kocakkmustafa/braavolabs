import { describe, expect, it } from "vitest";
import { uxLabEnabled } from "./flag";
import { classifyIntent, effectiveIntent, flowForIntent } from "./intent";
import {
  BATCH_APPROVE_ENABLED, CONFIRM_PHRASE, approvalFacts, approvalIsDangerous, companyLine, confirmOk, expectedFromYou, groupRuns, groupsForRuns, listedCostUsd, parseKaput,
  type LabApproval,
} from "./facts";
import { sampleApprovalGroups, sampleRuns } from "./fixtures";

describe("bayrak (04-design.md §12.1)", () => {
  it("varsayılan KAPALI; yalnız 1/true açar", () => {
    expect(uxLabEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes", "on", "2"]) expect(uxLabEnabled({ NEXT_PUBLIC_UX_LAB: v })).toBe(false);
    for (const v of ["1", "true", "TRUE", " 1 "]) expect(uxLabEnabled({ NEXT_PUBLIC_UX_LAB: v })).toBe(true);
  });
});

describe("niyet çubuğu — T1 normal sohbet başlat", () => {
  it("boş ve belirsiz metin SOHBET + düşük güven: plana düşmez", () => {
    expect(classifyIntent("")).toEqual({ kind: "chat", confidence: "low" });
    expect(classifyIntent("merhaba")).toEqual({ kind: "chat", confidence: "low" });
    expect(flowForIntent(effectiveIntent(classifyIntent("merhaba"), null))).toBe("chat");
  });
  it("soru sohbettir (yüksek güven), iş fiili olsa bile soru işareti sohbet yapar", () => {
    expect(classifyIntent("Bu hafta kaç e-posta geldi?")).toEqual({ kind: "chat", confidence: "high" });
    expect(classifyIntent("How do I add a user")).toEqual({ kind: "chat", confidence: "high" });
  });
  it("iş fiili + yeterli uzunluk = İş; Türkçe karakter kenarlarında da (\\b tuzağı)", () => {
    expect(classifyIntent("Müşteri e-postalarını özetle ve taslak olarak kaydet")).toEqual({ kind: "job", confidence: "high" });
    expect(classifyIntent("Özetle bunu şimdi lütfen")).toMatchObject({ kind: "job" });
    expect(classifyIntent("özetle")).toMatchObject({ kind: "chat", confidence: "low" });
    expect(classifyIntent("Summarize the customer emails into a draft")).toMatchObject({ kind: "job" });
  });
  it("ajan isteği Ajan'a gider", () => {
    expect(classifyIntent("Her sabah satış e-postalarını özetleyen bir ajan oluştur")).toEqual({ kind: "agent", confidence: "high" });
    expect(classifyIntent("create a new agent for support")).toMatchObject({ kind: "agent" });
  });
  it("kullanıcı seçimi tahmini ezer; sohbet seçiliyken plan akışı seçilmez", () => {
    const g = classifyIntent("Müşteri e-postalarını özetle ve taslak olarak kaydet");
    expect(effectiveIntent(g, "chat")).toBe("chat");
    expect(flowForIntent("chat")).toBe("chat");
    expect(flowForIntent("job")).toBe("plan");
    expect(flowForIntent("agent")).toBe("agent");
  });
});

const approval = (over: Partial<LabApproval> = {}): LabApproval => ({ id: "a", runId: "r", status: "PENDING", createdAt: "2026-11-11T00:00:00Z", ...over });

describe("onay anlama — T4 (hazır alanlar + 'bilgi yok')", () => {
  it("kaynak alan yoksa değer null (uydurulmaz); tutar yoksa em dash", () => {
    const f = Object.fromEntries(approvalFacts(approval({ description: "X gönder" })).map((x) => [x.key, x.value]));
    expect(f).toMatchObject({ what: "X gönder", tool: null, permissions: null, data: null, reversible: null, risk: null, draft: null, amount: "—" });
  });
  it("PR #133 `details` ve artifact görünür; reversible yalnız kesin değerde yazılır", () => {
    const a = approval({ description: "d", amountUsd: "25", metadata: { toolName: "ads.budget" }, artifact: { kind: "message", body: "merhaba" },
      details: { risk: "medium", permissions: ["slack:write", "x"], dataTransfer: ["a ← b"], reversible: true } });
    const f = Object.fromEntries(approvalFacts(a).map((x) => [x.key, x.value]));
    expect(f.tool).toBe("ads.budget");
    expect(f.permissions).toBe("slack:write, x");
    expect(f.data).toBe("a ← b");
    expect(f.reversible).toBe("yes");
    expect(f.risk).toBe("medium");
    expect(f.draft).toBe("merhaba");
    expect(f.amount).toMatch(/25/);
  });
  it("tehlikeli = para > 0 ya da yüksek risk ya da geri alınamaz", () => {
    expect(approvalIsDangerous(approval())).toBe(false);
    expect(approvalIsDangerous(approval({ amountUsd: 0 }))).toBe(false);
    expect(approvalIsDangerous(approval({ amountUsd: "0.01" }))).toBe(true);
    expect(approvalIsDangerous(approval({ details: { risk: "high", permissions: null, dataTransfer: null, reversible: null } }))).toBe(true);
    expect(approvalIsDangerous(approval({ details: { risk: "low", permissions: null, dataTransfer: null, reversible: false } }))).toBe(true);
    expect(approvalIsDangerous(approval({ details: { risk: "medium", permissions: null, dataTransfer: null, reversible: null } }))).toBe(false);
  });
  it("ikinci adım: ifade birebir (tr büyük/küçük harf duyarsız) ve dolu sebep; toplu onay KAPALI", () => {
    expect(confirmOk({ phrase: CONFIRM_PHRASE, reason: "bütçe tamam" })).toBe(true);
    expect(confirmOk({ phrase: "  onaylıyorum ", reason: "abc" })).toBe(true);
    expect(confirmOk({ phrase: "ONAYLIYORUM", reason: "abc" })).toBe(true);
    expect(confirmOk({ phrase: "onayla", reason: "abc" })).toBe(false);
    expect(confirmOk({ phrase: CONFIRM_PHRASE, reason: "  " })).toBe(false);
    expect(confirmOk({ phrase: CONFIRM_PHRASE, reason: "ab" })).toBe(false);
    expect(BATCH_APPROVE_ENABLED).toBe(false);
  });
});

describe("devam eden iş + şirket durumu — T3/T6", () => {
  it("kovalar sunucunun bucket alanından gelir; bucket'ı null iş gizlenir", () => {
    const m = groupRuns([...sampleRuns(), { ...sampleRuns()[0], id: "x", bucket: null }]);
    expect(m.working.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(m.needs_approval.map((r) => r.id)).toEqual(["r3"]);
    expect(m.stuck.map((r) => r.id)).toEqual(["r4"]);
    expect(m.done.map((r) => r.id)).toEqual(["r5", "r6"]);
  });
  it("beklenen ve şirket satırı aynı sayıları verir; harcama yalnız listelenen işler", () => {
    const runs = sampleRuns(); const groups = sampleApprovalGroups();
    expect(expectedFromYou(groups, runs)).toEqual({ approvals: 2, stuck: 1 });
    expect(companyLine(groups, runs)).toMatchObject({ running: 2, approvals: 2, stuck: 1, done: 2 });
    expect(listedCostUsd(runs)).toBeCloseTo(0.42 + 0.18 + 0.05 + 1.2 + 0.31 + 0.07, 6);
    expect(companyLine([], [])).toEqual({ running: 0, approvals: 0, stuck: 0, done: 0, listedCostUsd: 0 });
  });
});

describe("şirket süzgeci (reviewer ENGEL 3)", () => {
  it("onay grupları yalnız seçili şirketin koşularına göre sayılır", () => {
    const runs = sampleRuns(); const groups = sampleApprovalGroups();
    const mine = runs.filter((r) => r.id !== "r3"); // r3 başka şirketin
    const g = groupsForRuns(groups, mine);
    expect(g.map((x) => x.runId)).toEqual(["r4"]);
    expect(companyLine(g, mine).approvals).toBe(1);
    expect(groupsForRuns(groups, [])).toEqual([]);
  });
});

describe("Kaputu Aç — T7 (savunmacı okuma)", () => {
  it("bozuk gövde boş Kaput verir, fırlatmaz", () => {
    for (const bad of [null, undefined, 3, "x", [], { steps: "no" }]) expect(parseKaput(bad)).toMatchObject({ steps: [], toolCallCount: 0, handoffCount: null });
  });
  it("adım + araç çağrısı + maliyet okunur; eksik alanlar null", () => {
    const k = parseKaput({ costUsd: "0.42", steps: [
      { id: "s1", stepIndex: 0, name: "Oku", status: "COMPLETED", costUsd: 0.05, durationMs: 10, toolCalls: [{ id: "t", toolName: "gmail.list", status: "completed", durationMs: 5 }, 7] },
      { agentRole: "yazar", status: null },
    ] });
    expect(k.totalCostUsd).toBe(0.42);
    expect(k.steps).toHaveLength(2);
    expect(k.steps[0]).toMatchObject({ name: "Oku", status: "completed", costUsd: 0.05 });
    expect(k.steps[0].toolCalls).toEqual([{ id: "t", toolName: "gmail.list", status: "completed", durationMs: 5, error: null }]);
    expect(k.steps[1]).toMatchObject({ name: "yazar", status: "unknown", costUsd: null, toolCalls: [] });
    expect(k.toolCallCount).toBe(1);
  });
});
