/** BRA-UX-API-05b — ajan yanıtı → JobMessage ASSISTANT. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordAssistantReply, sanitizeAssistantText, replyLogWhere, ASSISTANT_INTERNAL_TEXT, ASSISTANT_MASK, ASSISTANT_REDACTED_TEXT, ASSISTANT_TRUNCATION_MARK, CHAT_REPLY_ACTION } from "../chat-reply";
import { CHAT_MAX_CONTENT, CHAT_MAX_MESSAGES_PER_RUN } from "../chat";

const runFindFirst = vi.fn();
const msgFindMany = vi.fn();
const msgCount = vi.fn();
const msgCreate = vi.fn();
const logFindFirst = vi.fn();
const logCreate = vi.fn();
const execRaw = vi.fn();
const db = {
  $transaction: async (fn: (tx: unknown) => unknown) => fn({
    $executeRaw: execRaw,
    run: { findFirst: runFindFirst },
    jobMessage: { findMany: msgFindMany, count: msgCount, create: msgCreate },
    activityLog: { findFirst: logFindFirst, create: logCreate },
  }),
};
const steer = [{ kind: "STEER", content: "Lütfen kısalt" }];
const base = { tenantId: "t1", runId: "r1", steers: steer, content: "Tamam, kısalttım." };

beforeEach(() => {
  vi.clearAllMocks();
  runFindFirst.mockResolvedValue({ id: "r1", status: "RUNNING" });
  msgFindMany.mockResolvedValue([{ id: "u-msg", content: "Lütfen kısalt" }]);
  msgCount.mockResolvedValue(3);
  logFindFirst.mockResolvedValue(null);
  msgCreate.mockResolvedValue({ id: "a-msg" });
});

describe("recordAssistantReply", () => {
  it("ASSISTANT yazar, kullanıcı mesajı id'sini ActivityLog'da taşır", async () => {
    expect(await recordAssistantReply(db, base)).toBe("a-msg");
    expect(msgCreate).toHaveBeenCalledWith({ data: { tenantId: "t1", runId: "r1", role: "ASSISTANT", content: "Tamam, kısalttım.", authorUserId: null } });
    expect(logCreate.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", action: CHAT_REPLY_ACTION, resourceId: "r1", details: { messageId: "a-msg", replyToMessageIds: ["u-msg"] } });
  });
  it("kiracı kapsamı: koşu kiracıya ait değilse yazmaz; sorgular tenantId taşır", async () => {
    runFindFirst.mockResolvedValue(null);
    expect(await recordAssistantReply(db, base)).toBeNull();
    expect(msgCreate).not.toHaveBeenCalled();
    runFindFirst.mockResolvedValue({ id: "r1", status: "RUNNING" });
    await recordAssistantReply(db, base);
    expect(runFindFirst.mock.calls[1][0].where.pipeline.company.tenantId).toBe("t1");
    expect(msgFindMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", runId: "r1", role: "USER" });
  });
  it("idempotans: aynı kullanıcı mesajı zaten yanıtlandıysa ikinci ASSISTANT yok", async () => {
    logFindFirst.mockResolvedValue({ id: "l1" });
    expect(await recordAssistantReply(db, base)).toBeNull();
    expect(msgCreate).not.toHaveBeenCalled();
  });
  it("sohbet kaynaklı olmayan steer (/steer, INPUT) için kayıt yok", async () => {
    msgFindMany.mockResolvedValue([]);
    expect(await recordAssistantReply(db, base)).toBeNull();
    expect(await recordAssistantReply(db, { ...base, steers: [{ kind: "INPUT", content: "Lütfen kısalt" }] })).toBeNull();
    expect(msgCreate).not.toHaveBeenCalled();
  });
  it("boş yanıt: kayıt yok", async () => {
    expect(await recordAssistantReply(db, { ...base, content: "  " })).toBeNull();
    expect(msgCreate).not.toHaveBeenCalled();
  });
  it("mesaj tavanında yazmaz", async () => {
    msgCount.mockResolvedValue(CHAT_MAX_MESSAGES_PER_RUN);
    expect(await recordAssistantReply(db, base)).toBeNull();
  });
  it("sır sızmaz: yer tutucu yazılır, ham değer asla", async () => {
    await recordAssistantReply(db, { ...base, content: "anahtar sk-abcdefghijklmnopqrstuvwx" });
    expect(msgCreate.mock.calls[0][0].data.content).toBe(ASSISTANT_REDACTED_TEXT);
  });
  it("uzun yanıt kırpılır ve işaretlenir", () => {
    const out = sanitizeAssistantText("a".repeat(CHAT_MAX_CONTENT + 500))!;
    expect(out.length).toBe(CHAT_MAX_CONTENT);
    expect(out.endsWith(ASSISTANT_TRUNCATION_MARK)).toBe(true);
    expect(sanitizeAssistantText("kısa")).toBe("kısa");
  });

  it("idempotans sorgu şekli birebir sabit (dizi argümanlı array_contains) ve kilit alınır", async () => {
    await recordAssistantReply(db, base);
    expect(logFindFirst.mock.calls[0][0].where).toEqual({
      tenantId: "t1", action: CHAT_REPLY_ACTION, resourceId: "r1", details: { path: ["replyToMessageIds"], array_contains: ["u-msg"] },
    });
    expect(replyLogWhere("t1", "r1", "u-msg").details.array_contains).toEqual(["u-msg"]);
    expect(execRaw).toHaveBeenCalledOnce();
    expect(msgFindMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });
  it.each(["CANCELLED", "PAUSED", "WAITING_APPROVAL"])("koşu %s ise yazmaz", async (status) => {
    runFindFirst.mockResolvedValue({ id: "r1", status });
    expect(await recordAssistantReply(db, base)).toBeNull();
    expect(msgCreate).not.toHaveBeenCalled();
  });
  it("aynı içerikli iki kullanıcı mesajı: en yenisine bağlanır; yanıtlanmışsa sıradakine", async () => {
    msgFindMany.mockResolvedValue([{ id: "new", content: "Lütfen kısalt" }, { id: "old", content: "Lütfen kısalt" }]);
    await recordAssistantReply(db, base);
    expect(logCreate.mock.calls[0][0].data.details.replyToMessageIds).toEqual(["new"]);
    logCreate.mockClear();
    logFindFirst.mockImplementation(async ({ where }: any) => (where.details.array_contains[0] === "new" ? { id: "l" } : null));
    await recordAssistantReply(db, base);
    expect(logCreate.mock.calls[0][0].data.details.replyToMessageIds).toEqual(["old"]);
  });
  it("iki steer -> tek ASSISTANT, ikisine de bağlı", async () => {
    msgFindMany.mockResolvedValue([{ id: "m2", content: "B" }, { id: "m1", content: "A" }]);
    await recordAssistantReply(db, { ...base, steers: [{ kind: "STEER", content: "A" }, { kind: "STEER", content: "B" }] });
    expect(msgCreate).toHaveBeenCalledOnce();
    expect(logCreate.mock.calls[0][0].data.details.replyToMessageIds).toEqual(["m1", "m2"]);
  });
  it("sızıntı: ham araç işaretlemesi/sistem istemi yer tutucuya döner; e-posta ve uzun rakam maskelenir", () => {
    for (const t of [
      '<tool_call>{"name":"x"}</tool_call>',
      '{"name":"send_email","arguments":{"to":"a"}}',
      "Available tools:\n- foo: bar",
      "[Tool result] {...}",
      "system prompt: sen bir ...",
    ]) expect(sanitizeAssistantText(t)).toBe(ASSISTANT_INTERNAL_TEXT);
    expect(sanitizeAssistantText("Yaz: ali@example.com, tel 0555 123 45 67, kart 4111 1111 1111 1111, 3 madde")).toBe(
      `Yaz: ${ASSISTANT_MASK}, tel ${ASSISTANT_MASK}, kart ${ASSISTANT_MASK}, 3 madde`);
  });
});
