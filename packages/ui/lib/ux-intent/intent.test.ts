import { describe, expect, it } from "vitest";
import { classifyIntent, effectiveIntent, flowForIntent } from "./intent";

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

