/**
 * BRA-UX-API-01 — onay `details` türetmesi (saf fonksiyon): doğru değer, eksik/bozuk -> null,
 * gizli anahtar sızmaz, kırpma.
 */
import { describe, it, expect } from "vitest";
import { deriveApprovalDetails, withApprovalDetails, MAX_DETAIL_ITEMS, MAX_DETAIL_STRING } from "../details";

const NULLS = { risk: null, permissions: null, dataTransfer: null, reversible: null };

describe("deriveApprovalDetails", () => {
  it("step kapısı: risk + tool; dataTransfer/reversible null", () => {
    const d = deriveApprovalDetails("SPEND", { gate: "step", stepIndex: 2, stepName: "x", tool: "send_email", risk: "HIGH" });
    expect(d).toEqual({ risk: "high", permissions: ["send_email"], dataTransfer: null, reversible: null });
  });

  it("araç kapısı: toolName yetki; girdi ALAN ADLARI dataTransfer, değerler yok; risk null", () => {
    const d = deriveApprovalDetails("SPEND", { toolName: "send_email", input: { to: "SECRET-VAL", subject: "s" }, moneyTouching: true });
    expect(d.risk).toBeNull();
    expect(d.permissions).toEqual(["send_email"]);
    expect(d.dataTransfer).toEqual(["send_email ← girdi alanları: to, subject"]);
    expect(d.reversible).toBeNull();
    expect(JSON.stringify(d)).not.toContain("SECRET-VAL");
  });

  it("EXTERNAL_CONTROL ve HANDOFF", () => {
    expect(deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: "c1", action: "PAUSE", targetId: "t1" }))
      .toEqual({ risk: null, permissions: ["external_control:PAUSE"], dataTransfer: ["PAUSE → bağlantı c1, hedef t1"], reversible: null });
    expect(deriveApprovalDetails("HANDOFF", { handoffId: "h", suggestedProvider: "openai", suggestedModel: "gpt-x" }))
      .toEqual({ risk: null, permissions: null, dataTransfer: ["koşu → openai / gpt-x"], reversible: null });
  });

  it("INPUT ve bilinmeyen tip: hepsi null", () => {
    expect(deriveApprovalDetails("INPUT", { toolName: "ask_user", question: "q" })).toEqual(NULLS);
    expect(deriveApprovalDetails("NEW_TYPE", { toolName: "x" })).toEqual(NULLS);
  });

  it.each([null, undefined, "str", 5, [], [1, 2], {}])("bozuk/boş metadata %j -> hepsi null", (m) => {
    expect(deriveApprovalDetails("SPEND", m)).toEqual(NULLS);
  });

  it("beklenmeyen tipler null: risk sayı/bilinmeyen, tool nesne", () => {
    expect(deriveApprovalDetails("SPEND", { gate: "step", risk: 3, tool: { a: 1 } })).toEqual(NULLS);
    expect(deriveApprovalDetails("SPEND", { gate: "step", risk: "critical", tool: "" }).risk).toBeNull();
    expect(deriveApprovalDetails("SPEND", { toolName: 42, input: "x" })).toEqual(NULLS);
  });

  it("gizli anahtarlar hiçbir alanda görünmez", () => {
    const d = deriveApprovalDetails("SPEND", {
      toolName: "send_email",
      input: { apiKey: "K", access_token: "T", password: "P", Authorization: "A", client_secret: "S", to: "x" },
    });
    const json = JSON.stringify(d);
    for (const bad of ["apiKey", "access_token", "password", "Authorization", "client_secret"]) expect(json).not.toContain(bad);
    expect(d.dataTransfer).toEqual(["send_email ← girdi alanları: to"]);
    // gizli görünen tool adı da düşer
    expect(deriveApprovalDetails("SPEND", { toolName: "get_secret_token" }).permissions).toBeNull();
  });

  it("kırpma: uzun string <= 200, dizi <= 10 öğe", () => {
    const long = "a".repeat(500);
    const d = deriveApprovalDetails("SPEND", { toolName: long, input: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, i])) });
    expect(d.permissions![0].length).toBeLessThanOrEqual(MAX_DETAIL_STRING);
    expect(d.dataTransfer![0].length).toBeLessThanOrEqual(MAX_DETAIL_STRING);
    expect(d.dataTransfer!.length).toBeLessThanOrEqual(MAX_DETAIL_ITEMS);
  });

  it("çıktı anahtar kümesi kapalı; reversible her zaman null", () => {
    for (const [t, m] of [["SPEND", { toolName: "x" }], ["HANDOFF", {}], ["SPEND", { gate: "step", risk: "low" }]] as const) {
      const d = deriveApprovalDetails(t, m);
      expect(Object.keys(d).sort()).toEqual(["dataTransfer", "permissions", "reversible", "risk"]);
      expect(d.reversible).toBeNull();
    }
  });

  it("withApprovalDetails mevcut alanları aynen korur, yalnız details ekler", () => {
    const row = { id: "a", type: "SPEND", metadata: { toolName: "t" }, description: "d" };
    const out = withApprovalDetails(row);
    expect(out).toMatchObject(row);
    expect(Object.keys(out).sort()).toEqual(["description", "details", "id", "metadata", "type"]);
  });
});
