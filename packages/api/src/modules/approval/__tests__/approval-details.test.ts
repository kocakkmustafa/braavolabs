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
  });

  it("araç adı: güvenli biçimli ad geçer (yanlış pozitif yok); biçim dışı / sk- biçimli düşer", () => {
    for (const t of ["keyword_research", "get_token_price", "send_email"]) {
      expect(deriveApprovalDetails("SPEND", { toolName: t }).permissions).toEqual([t]);
    }
    for (const t of ["sk-live-abcdef", "https://u:p@h", "a b", "ghp_abc123", "eyJhbGciOi"]) {
      expect(deriveApprovalDetails("SPEND", { toolName: t }).permissions).toBeNull();
    }
  });

  it("anahtar adı sızıntıları: x-api-key, pwd/auth/jwt/session/otp/pin/private, sk-… adı, biçim dışı ad", () => {
    const input = {
      "x-api-key": 1, pwd: 1, auth: 1, jwt: 1, session_id: 1, otp: 1, pin: 1, private_key: 1,
      "sk-abcdef0123456789": 1, "has space": 1, "9starts": 1, ["a".repeat(60)]: 1, to: 1, subject: 1,
    };
    const d = deriveApprovalDetails("SPEND", { toolName: "send_email", input });
    expect(d.dataTransfer).toEqual(["send_email ← girdi alanları: to, subject"]);
    const json = JSON.stringify(d);
    for (const bad of ["x-api-key", "pwd", "jwt", "session", "otp", "pin", "private", "sk-abc", "has space"]) {
      expect(json).not.toContain(bad);
    }
  });

  it("iç içe nesne: yalnız üst düzey alan adı; iç değer/anahtar sızmaz", () => {
    const d = deriveApprovalDetails("SPEND", {
      toolName: "post",
      input: { payload: { password: "P4SS", "sk-nested0123456789": "V" }, to: "x" },
    });
    expect(d.dataTransfer).toEqual(["post ← girdi alanları: payload, to"]);
    expect(JSON.stringify(d)).not.toMatch(/P4SS|sk-nested|password/);
  });

  it("EXTERNAL_CONTROL targetId/connectionId: URL kimlik bilgisi ve sk-… ham olarak çıkmaz", () => {
    const bads = ["https://u:p@host/x", "https://h/?a=sk-live-abc", "sk-live-abcdef", "id with space", "a".repeat(65), "x?y=1"];
    for (const bad of bads) {
      const onTarget = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: "c1", action: "PAUSE", targetId: bad });
      expect(onTarget.dataTransfer).toEqual(["PAUSE → bağlantı c1"]);
      const onConn = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: bad, action: "PAUSE", targetId: "t1" });
      expect(onConn.dataTransfer).toBeNull();
      for (const d of [onTarget, onConn]) expect(JSON.stringify(d)).not.toMatch(/u:p@|sk-live|\?a=|with space/);
    }
    // cuid içinde "key" geçmesi yanlış pozitif olmaz
    expect(deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: "ckeyabc123", action: "TRIGGER", targetId: "t" }).dataTransfer)
      .toEqual(["TRIGGER → bağlantı ckeyabc123, hedef t"]);
  });

  // BRA-UX-API-01b — ID_SAFE sertleştirme: her desen için ≥1 sızıntı testi (targetId ve connectionId).
  const LEAKS: Array<[string, string]> = [
    ["iki nokta: user:pass", "user:pass"],
    ["iki nokta: acct:…", "acct:1Abc23"],
    ["acct_ öneki her konumda", "id-acct_1Abc23"],
    ["32 hane hex (küçük)", "0123456789abcdef0123456789abcdef"],
    ["32 hane hex (büyük harf)", "0123456789ABCDEF0123456789ABCDEF"],
    ["hex gömülü (öne/arkaya ek)", "pre-0123456789abcdef0123456789abcdef-post"],
    ["≥40 karakter blok", "abcXYZ_".repeat(6)],
    ["sk-live her konumda", "my.sk-live-abc123"],
    ["sk_test her konumda", "idsk_test_abc123"],
    ["kelime başı sk-", "x_sk-abc123"],
    ["pk_live her konumda", "z.pk_live_abc123"],
    ["rk_live her konumda", "z.rk_live_abc123"],
    ["ghp_ öneki her konumda", "id-ghp_abcd1234"],
    ["xox* token her konumda", "t-xoxb-123456"],
    ["AKIA anahtar kimliği her konumda", "idAKIAIOSFODNN7EXAMPLE"],
    ["JWT (eyJ) her konumda", "ref.eyJhbGciOiJIUzI1"],
    ["whsec_ her konumda", "wh-whsec_abc123"],
  ];
  it.each(LEAKS)("ID sızıntısı engellenir — %s", (_name, bad) => {
    const onTarget = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: "c1", action: "PAUSE", targetId: bad });
    expect(onTarget.dataTransfer).toEqual(["PAUSE → bağlantı c1"]);
    const onConn = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: bad, action: "PAUSE", targetId: "t1" });
    expect(onConn.dataTransfer).toBeNull();
    for (const d of [onTarget, onConn]) expect(JSON.stringify(d)).not.toContain(bad);
  });

  it("ID yanlış pozitifleri yok: cuid, uuid (tireli), slug, 'risk-1'/'desk-1' geçer", () => {
    for (const ok of ["ckeyabc123", "cjld2cjxh0000qzrmn831i7rn", "123e4567-e89b-12d3-a456-426614174000", "conn.prod-1", "risk-1", "desk-1", "t_42"]) {
      const d = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: ok, action: "PAUSE", targetId: ok });
      expect(d.dataTransfer).toEqual([`PAUSE → bağlantı ${ok}, hedef ${ok}`]);
    }
  });

  it("çok anahtarlı girdi: yalnız ilk 50 anahtar incelenir", () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < 50; i++) input[`password${i}`] = i;
    input.visible_after_50 = 1;
    expect(deriveApprovalDetails("SPEND", { toolName: "t", input }).dataTransfer).toBeNull();
  });

  it("kırpma: uzun string <= 200, dizi <= 10 öğe", () => {
    const long = "a".repeat(60);
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
