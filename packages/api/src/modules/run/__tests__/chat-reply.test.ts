/** BRA-UX-API-05b — ajan yanıtı → JobMessage ASSISTANT. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordAssistantReply, sanitizeAssistantText, ASSISTANT_REDACTED_TEXT, ASSISTANT_TRUNCATION_MARK, CHAT_REPLY_ACTION } from "../chat-reply";
import { CHAT_MAX_CONTENT, CHAT_MAX_MESSAGES_PER_RUN } from "../chat";

const runFindFirst = vi.fn();
const msgFindMany = vi.fn();
const msgCount = vi.fn();
const msgCreate = vi.fn();
const logFindFirst = vi.fn();
const logCreate = vi.fn();
const db = {
  $transaction: async (fn: (tx: unknown) => unknown) => fn({
    run: { findFirst: runFindFirst },
    jobMessage: { findMany: msgFindMany, count: msgCount, create: msgCreate },
    activityLog: { findFirst: logFindFirst, create: logCreate },
  }),
};
const steer = [{ kind: "STEER", content: "Lütfen kısalt" }];
const base = { tenantId: "t1", runId: "r1", steers: steer, content: "Tamam, kısalttım." };

beforeEach(() => {
  vi.clearAllMocks();
  runFindFirst.mockResolvedValue({ id: "r1" });
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
    runFindFirst.mockResolvedValue({ id: "r1" });
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
});
