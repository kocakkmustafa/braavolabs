/**
 * BRA-UX-04 — ÖRNEK VERİ. Gerçek API yanıtı DEĞİLDİR ve arayüzde her yerde "ÖRNEK" etiketiyle gösterilir.
 * Şekiller gerçek sözleşme tipleridir (InboxRun, InboxApproval + PR #133 `details`, PlanCardView): yalnız değerler
 * kurgudur. Zaman damgaları sabittir (ekran görüntüleri tekrar üretilebilir olsun diye "n sn önce" yok).
 */
import type { InboxRun } from "../inbox";
import type { PlanCardView } from "../planCardParse";
import type { LabApprovalGroup } from "./facts";

export const SAMPLE_COMPANY = { id: "sample-company", name: "Atölye" } as const;

const T0 = "2026-11-11T09:00:00.000Z";
const run = (id: string, title: string, over: Partial<InboxRun>): InboxRun => ({
  id, pipelineId: `p-${id}`, status: "RUNNING", state: "RUNNING", resultStatus: null, costUsd: 0, createdAt: T0, updatedAt: T0, bucket: "working",
  pipeline: { id: `p-${id}`, name: title, company: { ...SAMPLE_COMPANY } }, ...over,
});

export function sampleRuns(): InboxRun[] {
  return [
    run("r1", "Rapor taslağı", { costUsd: 0.42 }),
    run("r2", "Haftalık e-posta özeti", { costUsd: 0.18 }),
    run("r3", "Slack'e haftalık özet gönder", { status: "WAITING_APPROVAL", state: "NEEDS_APPROVAL", bucket: "needs_approval", costUsd: 0.05 }),
    run("r4", "Müşteri veri aktarımı", { costUsd: 1.2, bucket: "stuck", heartbeatAt: "2026-11-11T08:00:00.000Z" }),
    run("r5", "Fatura özeti", { status: "COMPLETED", state: "COMPLETED", resultStatus: "VERIFIED", bucket: "done", costUsd: 0.31 }),
    run("r6", "Sunum taslağı", { status: "COMPLETED", state: "COMPLETED", resultStatus: "UNVERIFIED", bucket: "done", costUsd: 0.07 }),
  ];
}

export function sampleApprovalGroups(): LabApprovalGroup[] {
  return [
    {
      runId: "r3", runTitle: "Slack'e haftalık özet gönder",
      approvals: [{
        id: "a1", runId: "r3", type: "TOOL", status: "PENDING", description: "#genel kanalına 1 mesaj gönder", amountUsd: null, createdAt: T0,
        metadata: { toolName: "slack.post" },
        details: { risk: "medium", permissions: ["slack:write"], dataTransfer: ["slack.post ← girdi alanları: channel, text"], reversible: null },
        artifact: { kind: "message", title: "#genel", body: "Bu hafta 14 e-posta özetlendi; 3 tanesi yanıt bekliyor." },
      }],
    },
    {
      runId: "r4", runTitle: "Müşteri veri aktarımı",
      approvals: [{
        id: "a2", runId: "r4", type: "SPEND", status: "PENDING", description: "Reklam bütçesini artır", amountUsd: 25, createdAt: T0,
        metadata: { toolName: "ads.budget" },
        details: { risk: "high", permissions: ["ads:spend"], dataTransfer: null, reversible: null },
      }],
    },
  ];
}

export const SAMPLE_KAPUT: Record<string, unknown> = {
  r1: {
    costUsd: 0.42,
    steps: [
      { id: "s1", stepIndex: 0, name: "Talebi netleştir", agentRole: "analist", status: "COMPLETED", costUsd: 0.05, durationMs: 4200, toolCalls: [{ id: "t1", toolName: "gmail.list", status: "completed", durationMs: 120 }] },
      { id: "s2", stepIndex: 1, name: "Taslak çıktıyı hazırla", agentRole: "analist", status: "RUNNING", costUsd: 0.37, durationMs: 9100, toolCalls: [{ id: "t2", toolName: "draft.write", status: "completed", durationMs: 840 }] },
      { id: "s3", stepIndex: 2, name: "Sonucu özetle ve sun", agentRole: "yazar", status: "PENDING", costUsd: null },
    ],
  },
};

/** Planlama örnekleri: düşük riskli (onaysız) ve onay adımlı (bayrak kapalıyken /jobs/start 422 döner). */
export const SAMPLE_PLAN_LOW: PlanCardView = {
  title: "Müşteri e-postalarını özetle", goal: "Gelen e-postaları özetle ve taslak olarak kaydet.", risk: "low",
  steps: [
    { title: "Talebi netleştir, kaynak topla", tool: "read", needsApproval: false, risk: "low" },
    { title: "Taslak çıktıyı hazırla", tool: "draft", needsApproval: false, risk: "low" },
    { title: "Sonucu özetle ve sun", tool: "summarize", needsApproval: false, risk: "low" },
  ],
  estimate: { costUsd: { low: 0.02, high: 0.06 }, priced: true },
};
export const SAMPLE_PLAN_HIGH: PlanCardView = {
  title: "Haftalık özeti Slack'e gönder", goal: "Özeti hazırla ve #genel kanalına gönder.", risk: "high",
  steps: [
    { title: "Özeti hazırla", tool: "summarize", needsApproval: false, risk: "low" },
    { title: "Slack'e gönder", tool: "slack.post", needsApproval: true, risk: "high" },
  ],
  estimate: { costUsd: { low: 0.03, high: 0.08 }, priced: true },
};

/** "Ajan oluştur" örneği: bağlı olmayan araç `droppedTools` ile bildirilir (T5). */
export const SAMPLE_AGENT = { name: "Satış Özetçisi", role: "analist", tools: ["gmail", "slack"], droppedTools: ["hubspot"] } as const;
export const SAMPLE_INTEGRATIONS = ["gmail", "slack"] as const;
