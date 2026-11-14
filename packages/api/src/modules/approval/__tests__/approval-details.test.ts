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
    ["40 karakter blok (sınır)", "abcXYZ_".repeat(5) + "abcde"],
    ["sk-live kelime başında", "my.sk-live-abc123"],
    ["sk_test sınırda (_ öncesi)", "id_sk_test_abc123"],
    ["sk_test gömülü, uzun gövde", "idsk_test_4eC39HqLyjWDarjtT1zdp7dc"],
    ["sk-ant gömülü, uzun gövde", "idsk-ant-api03-abcdefghijklmnop"],
    ["SK-LIVE büyük harf", "my.SK-LIVE-abc123"],
    ["Sk_Test karışık harf", "id.Sk_Test_abc123"],
    ["_ sonrası tireli sk-", "task_sk-abc123"],
    ["JWT sol sınır: tire", "x-eyJhbGciOiJIUzI1"],
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

  it("ID yanlış pozitifleri (01d): task-test-1, risk-test, keyjob, task_pk_1 ve komşu biçimler geçer", () => {
    const oks = [
      "task-test-1", "risk-test", "keyjob", "task_pk_1", "task-live-2", "desk_test_1", "disk-proj", "mask-ant-1",
      "task_rk_1", "flask_test", "monkeyjob", "okeyJ1",
      "abcXYZ_".repeat(5) + "abcd", // 39 karakter blok: sınırın altı
      "0123456789abcdef0123456789abcde", // 31 hane hex: sınırın altı
      "z".repeat(31) + "." + "z".repeat(32), // tam 64 karakter (ID_SAFE üst sınırı)
    ];
    for (const ok of oks) {
      const d = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: ok, action: "PAUSE", targetId: ok });
      expect(d.dataTransfer, ok).toEqual([`PAUSE → bağlantı ${ok}, hedef ${ok}`]);
    }
  });

  const B24 = "4eC39HqLyjWDarjtT1zdp7dc"; // 24 karakter gövde
  const idDt = (id: string) => deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: id, action: "PAUSE", targetId: "t" }).dataTransfer;

  it("ID yanlış pozitifleri (kısa gövde) geçmeli: flask_test, disk_test_configuration, task-test-1, risk-test", () => {
    for (const ok of ["flask_test", "disk_test_configuration", "task-test-1", "risk-test"]) {
      expect(idDt(ok), ok).toEqual([`PAUSE → bağlantı ${ok}, hedef t`]);
    }
  });

  it("BİLİNEN TAKAS (belgeleme): gömülü + kısa gövdeli önek geçer; ≥20 gövdeli gömülü yanlış pozitifler düşer", () => {
    expect(idDt("idsk_test_abc123")).toEqual(["PAUSE → bağlantı idsk_test_abc123, hedef t"]); // sızıntı geçer (takas)
    // Güvenli yönde yanlış pozitif: alan null olur.
    for (const fp of ["disk-proj-name-with-many-words", "bookmark_proj_list_all_items_in_repo", "task-test-cjld2cjxh0000qzrmn831i7rn"]) {
      expect(idDt(fp), fp).toBeNull();
    }
  });

  // BRA-UX-API-01d — ID_SECRET_EMBEDDED kolları (sol sınırsız, gövde ≥20).
  it.each([
    ["live", `idpk_live_${B24}`], ["test", `idrk_test_${B24}`], ["sk test", `idsk_test_${B24}`], ["sk live", `idsk-live-${B24}`],
    ["proj", "idsk-proj-" + "a".repeat(20)], ["proj, - içeren gövde", "idsk-proj-abcd-efgh-ijkl-mnopq"], ["ant", "idsk-ant-api03-abcdefghijklmnop"],
    ["büyük harf", `IDSK_TEST_${B24}`],
  ])("EMBEDDED kolu düşer — %s", (_n, bad) => {
    expect(idDt(bad)).toBeNull();
  });
  it("EMBEDDED gövde sınırı: 19 karakter geçer, 20 düşer", () => {
    expect(idDt("idsk_test_" + "a".repeat(19))).toEqual([`PAUSE → bağlantı idsk_test_${"a".repeat(19)}, hedef t`]);
    expect(idDt("idsk_test_" + "a".repeat(20))).toBeNull();
  });

  it("ID: 65 karakter ID_SAFE dışı; 64 sınırı üstü reddedilir", () => {
    const bad = "z".repeat(32) + "." + "z".repeat(32);
    expect(bad.length).toBe(65);
    const d = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: bad, action: "PAUSE", targetId: "t1" });
    expect(d.dataTransfer).toBeNull();
  });

  it("BİLİNEN TAKAS (belgeleme): noktalı/tireli bölünmüş hex süzgeçten geçer; davranış değiştirilmedi", () => {
    // 16+16 hane tek blok değil: uuid benzeri biçimlerin geçmesi için bilinçli.
    for (const ok of ["0123456789abcdef.0123456789abcdef", "0123456789abcdef-0123456789abcdef", "01234567-89abcdef-01234567-89abcdef"]) {
      const d = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: ok, action: "PAUSE", targetId: "t" });
      expect(d.dataTransfer).toEqual([`PAUSE → bağlantı ${ok}, hedef t`]);
    }
  });

  // BRA-UX-API-01d — aynı süzgeç araç adı / sağlayıcı / model / alan adı için.
  const NAME_LEAKS = ["0123456789abcdef0123456789abcdef", "pre:sk-live-abc123", "id.ghp_abcd1234", "t:acct_1Abc23", "t.eyJhbGciOiJIUzI1", "my.SK-LIVE-abc", "abcXYZ_".repeat(6), `idsk_test_${B24}`, `idpk_live_${B24}`, "idsk-proj-" + "a".repeat(20)];
  it.each(NAME_LEAKS)("araç adı süzgeci: %s düşer", (bad) => {
    expect(deriveApprovalDetails("SPEND", { gate: "step", tool: "x" + bad }).permissions).toBeNull();
    expect(deriveApprovalDetails("SPEND", { toolName: "a" + bad }).permissions).toBeNull();
    expect(deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "a" + bad, action: "PAUSE" }).permissions).toBeNull();
  });
  it("araç adı: task-test-1 / keyjob / task_pk_1 / a:b geçer", () => {
    for (const t of ["task-test-1", "keyjob", "task_pk_1", "ns:send_email"]) {
      expect(deriveApprovalDetails("SPEND", { toolName: t }).permissions).toEqual([t]);
    }
  });
  it.each(["0123456789abcdef0123456789abcdef", "x/sk-live-abc", "v/ghp_abcd1234", "p:acct_1Abc23", "v/eyJhbGciOiJIUzI1", "m/" + "abcXYZ_".repeat(6), `idsk_test_${B24}`, `idrk_live_${B24}`])(
    "sağlayıcı/model süzgeci: %s düşer",
    (bad) => {
      expect(deriveApprovalDetails("HANDOFF", { suggestedProvider: bad, suggestedModel: "gpt-4o" }).dataTransfer).toBeNull();
      expect(deriveApprovalDetails("HANDOFF", { suggestedProvider: "openai", suggestedModel: bad }).dataTransfer).toEqual(["koşu → openai"]);
    },
  );
  it("sağlayıcı/model: vendor/model, claude-3.5, task-test geçer", () => {
    expect(deriveApprovalDetails("HANDOFF", { suggestedProvider: "anthropic", suggestedModel: "vendor/claude-3.5" }).dataTransfer).toEqual(["koşu → anthropic / vendor/claude-3.5"]);
    expect(deriveApprovalDetails("HANDOFF", { suggestedProvider: "task-test", suggestedModel: "keyjob" }).dataTransfer).toEqual(["koşu → task-test / keyjob"]);
  });
  it("alan adı: hex / acct_ / sk-live / JWT adlı anahtarlar düşer; task-test-1, keyjob, task_pk_1 kalır", () => {
    const input = {
      a123456789abcdef0123456789abcdef: 1, acct_1Abc23: 1, "my.sk-live-a": 1, "x.eyJhbGciOiJ": 1, [`idsk_test_${B24}`]: 1,
      ["abcXYZ_".repeat(5) + "abcde"]: 1, "task-test-1": 1, keyjob: 1, task_pk_1: 1,
    };
    const d = deriveApprovalDetails("SPEND", { toolName: "t", input });
    expect(d.dataTransfer).toEqual(["t ← girdi alanları: task-test-1, keyjob, task_pk_1"]);
  });

  it("çok anahtarlı girdi: yalnız ilk 50 anahtar incelenir", () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < 50; i++) input[`password${i}`] = i;
    input.visible_after_50 = 1;
    expect(deriveApprovalDetails("SPEND", { toolName: "t", input }).dataTransfer).toBeNull();
  });

  it("kırpma: uzun string <= 200, dizi <= 10 öğe", () => {
    const long = "a.".repeat(30); // nokta: 40+ karakterlik blok süzgecine takılmaz
    const d = deriveApprovalDetails("SPEND", { toolName: long, input: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, i])) });
    expect(d.permissions![0].length).toBeLessThanOrEqual(MAX_DETAIL_STRING);
    expect(d.dataTransfer![0].length).toBeLessThanOrEqual(MAX_DETAIL_STRING);
    expect(d.dataTransfer!.length).toBeLessThanOrEqual(MAX_DETAIL_ITEMS);
  });

  describe("BRA-UX-API-01e: AIza… / glpat-… önekleri", () => {
    const AIZA = "AIza" + "Sy" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q"; // 39 karakter
    const GLPAT = "glpat-" + "aB3dE6gH9jK2mN5pQ8sT"; // 26 karakter
    it("uzunluklar tam 39 ve 26 (ID_LONG_BLOCK altında)", () => {
      expect(AIZA).toHaveLength(39);
      expect(GLPAT).toHaveLength(26);
    });
    it.each([AIZA, GLPAT, `id-${AIZA}`, `x.${GLPAT}`])("%s kimlik/araç/sağlayıcı/alan adı hiçbir alana girmez", (v) => {
      const e = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: v, action: "PAUSE", connectionId: v, targetId: v });
      expect(JSON.stringify(e)).not.toContain(v);
      expect(e.permissions).toBeNull();
      expect(e.dataTransfer).toBeNull();
      const s = deriveApprovalDetails("SPEND", { toolName: "send_email", input: { [v]: 1, to: 2 } });
      expect(s.dataTransfer).toEqual(["send_email ← girdi alanları: to"]);
      const h = deriveApprovalDetails("HANDOFF", { suggestedProvider: v, suggestedModel: v });
      expect(h.dataTransfer).toBeNull();
    });
    it("yanlış pozitif yok: AIzaWord, glpat-notes, gaiza, kısa gövdeler geçer", () => {
      for (const ok of ["AIzaWord", "glpat-notes", "gaiza-1", "AIza" + "a".repeat(19), "glpat-" + "a".repeat(19), "aiza_tool", "GLPAT-" + "a".repeat(20)]) {
        const d = deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "t", action: "PAUSE", connectionId: ok });
        expect(d.dataTransfer).toEqual([`PAUSE → bağlantı ${ok}`]);
      }
    });
  });

  it("metadata.reversible olumlu: gerçek boolean aynen döner (SPEND ve EXTERNAL_CONTROL)", () => {
    expect(deriveApprovalDetails("SPEND", { toolName: "pay", reversible: false }).reversible).toBe(false);
    expect(deriveApprovalDetails("SPEND", { toolName: "pay", reversible: true }).reversible).toBe(true);
    expect(deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "ec", action: "TRIGGER", reversible: false }).reversible).toBe(false);
    expect(deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "ec", action: "PAUSE", reversible: true }).reversible).toBe(true);
    // boolean olmayan şekiller null; step/HANDOFF kaynak yok
    expect(deriveApprovalDetails("SPEND", { toolName: "pay", reversible: "true" }).reversible).toBeNull();
    expect(deriveApprovalDetails("SPEND", { gate: "step", tool: "t", reversible: true }).reversible).toBeNull();
    expect(deriveApprovalDetails("HANDOFF", { suggestedProvider: "openai", reversible: true }).reversible).toBeNull();
  });

  it("çıktı anahtar kümesi kapalı; reversible kaynak yoksa null", () => {
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
