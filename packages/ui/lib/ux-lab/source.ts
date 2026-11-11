/**
 * BRA-UX-04 — prototipin veri kaynağı. İki gerçekleme aynı arayüzü sunar:
 *  - `liveSource(token)`: VAR OLAN uçlar (`/runs?bucket=`, `/approvals?groupBy=run`, `/approvals/:id/decide`, `/jobs/plan`,
 *    `/jobs/start`, `/runs/:id`, `/runs/:id/{pause,resume,stop}`, `/companies*`). Yeni uç YOK.
 *  - `sampleSource()`: bellek içi, ÖRNEK veri (oturum yok / `?mode=sample`); aynı durum makinesini (planFlow) besler.
 * Karar, eylem ve başlatma örnek kaynakta yalnız bellekte değişir; sunucuya hiçbir şey gitmez.
 */
import { api } from "../api";
import type { ApprovalDecision } from "../approvalDecision";
import { decideResult, type DecisionResult } from "../inboxActions";
import { INBOX_TABS, type InboxRun } from "../inbox";
import type { PlanResponse, StartResponse } from "../planCardParse";
import { parseKaput, type Kaput, type LabApprovalGroup } from "./facts";
import {
  SAMPLE_AGENT, SAMPLE_COMPANY, SAMPLE_INTEGRATIONS, SAMPLE_KAPUT, SAMPLE_PLAN_HIGH, SAMPLE_PLAN_LOW, sampleApprovalGroups, sampleRuns,
} from "./fixtures";

export interface LabCompany { id: string; name: string; agents: number | null; integrations: string[] | null }
export interface ComposeResult { name: string; role: string; tools: string[]; droppedTools: string[] }
export type LabRunAction = "pause" | "resume" | "stop";

export interface LabSource {
  mode: "sample" | "live";
  companies(): Promise<LabCompany[]>;
  runs(): Promise<InboxRun[]>;
  approvalGroups(): Promise<LabApprovalGroup[]>;
  plan(message: string, workspaceId?: string): Promise<PlanResponse>;
  start(body: { message: string; workspaceId?: string; planHash: string; idempotencyKey: string }): Promise<StartResponse>;
  decide(approvalId: string, decision: ApprovalDecision, note?: string): Promise<DecisionResult>;
  runAction(runId: string, action: LabRunAction): Promise<void>;
  kaput(runId: string): Promise<Kaput>;
  /** DİKKAT: `POST /companies/:id/agents/compose` ajanı HEMEN kaydeder (taslak ucu yok; bkz. ux-04-prototype.md). */
  composeAgent(companyId: string, description: string): Promise<ComposeResult>;
}

const names = (list: unknown): string[] | null =>
  Array.isArray(list) ? list.map((i) => (i && typeof i === "object" ? String((i as { provider?: unknown }).provider ?? "") : "")).filter(Boolean) : null;

export function liveSource(token: string): LabSource {
  return {
    mode: "live",
    async companies() {
      const list = await api.listCompanies(token);
      return Promise.all((Array.isArray(list) ? list : []).map(async (c): Promise<LabCompany> => {
        const [agents, integrations] = await Promise.all([
          api.listAgents(token, c.id).then((a) => (Array.isArray(a) ? a.length : null)).catch(() => null),
          api.listIntegrations(token, c.id).then(names).catch(() => null),
        ]);
        return { id: c.id, name: c.name ?? c.id, agents, integrations };
      }));
    },
    async runs() {
      const pages = await Promise.all(INBOX_TABS.map((b) => api.inboxRuns(token, b)));
      const seen = new Set<string>();
      return pages.flatMap((p) => p.runs).filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    },
    async approvalGroups() { return (await api.inboxApprovalGroups(token)).groups as LabApprovalGroup[]; },
    plan: (message, workspaceId) => api.jobPlan(token, message, workspaceId),
    start: (body) => api.jobStart(token, body),
    decide: (id, decision, note) => decideResult(() => api.decideApproval(token, id, decision, note)),
    async runAction(runId, action) { await api.runAction(token, runId, action); },
    async kaput(runId) {
      const [run, handoffCount] = await Promise.all([
        api.getRun(token, runId),
        api.listHandoffs(token, runId).then((h: { handoffs?: unknown[] } | null) => (Array.isArray(h?.handoffs) ? h!.handoffs!.length : null)).catch(() => null),
      ]);
      return { ...parseKaput(run), handoffCount };
    },
    async composeAgent(companyId, description) {
      const r = await api.composeAgent(token, companyId, description);
      return { name: r.agent.name, role: r.agent.role, tools: r.agent.tools, droppedTools: r.droppedTools };
    },
  };
}

/** Gerçek sunucunun bayrak kapalıyken verdiği 422 (DECISIONS.md:178); `startErrorKind` bunu "approvalGate" yapar. */
const gateError = () => Object.assign(new Error("high_risk_start_unsupported"), { status: 422, serverError: "high_risk_start_unsupported" });
const SEND_INTENT = /slack|gönder|send|mesaj/i;

export function sampleSource(): LabSource {
  let runs = sampleRuns();
  let groups = sampleApprovalGroups();
  let seq = 0;
  const delay = <T,>(v: T) => Promise.resolve(v);
  return {
    mode: "sample",
    companies: () => delay([{ ...SAMPLE_COMPANY, agents: 1, integrations: [...SAMPLE_INTEGRATIONS] }]),
    runs: () => delay(runs.map((r) => ({ ...r }))),
    approvalGroups: () => delay(groups.map((g) => ({ ...g, approvals: [...g.approvals] }))),
    plan: (message) => delay<PlanResponse>({
      intent: "job", card: SEND_INTENT.test(message) ? SAMPLE_PLAN_HIGH : SAMPLE_PLAN_LOW, planHash: SEND_INTENT.test(message) ? "sample-high" : "sample-low",
    }),
    async start(body) {
      if (body.planHash === "sample-high") throw gateError();
      const id = `sample-new-${++seq}`;
      const now = new Date().toISOString();
      runs = [{ id, pipelineId: `p-${id}`, status: "RUNNING", state: "RUNNING", resultStatus: null, costUsd: 0, createdAt: now, updatedAt: now, bucket: "working",
        pipeline: { id: `p-${id}`, name: SAMPLE_PLAN_LOW.title, company: { ...SAMPLE_COMPANY } } }, ...runs];
      return { runId: id, state: "RUNNING" };
    },
    async decide(id, decision) {
      const group = groups.find((g) => g.approvals.some((a) => a.id === id));
      if (!group) return { kind: "stale" };
      groups = groups.map((g) => ({ ...g, approvals: g.approvals.filter((a) => a.id !== id) })).filter((g) => g.approvals.length > 0);
      runs = runs.map((r) => (r.id !== group.runId ? r
        : decision === "APPROVED" ? { ...r, status: "RUNNING", state: "RUNNING" as const, bucket: "working" as const }
        : { ...r, status: "CANCELLED", state: "CANCELLED" as const, bucket: "done" as const }));
      return { kind: "ok" };
    },
    async runAction(runId, action) {
      runs = runs.map((r) => (r.id !== runId ? r
        : action === "pause" ? { ...r, status: "PAUSED", state: "PAUSED" as const, bucket: "stuck" as const }
        : action === "resume" ? { ...r, status: "RUNNING", state: "RUNNING" as const, bucket: "working" as const, heartbeatAt: null }
        : { ...r, status: "CANCELLED", state: "CANCELLED" as const, bucket: "done" as const }));
    },
    kaput: (runId) => delay({ ...parseKaput(SAMPLE_KAPUT[runId] ?? { steps: [], costUsd: runs.find((r) => r.id === runId)?.costUsd ?? null }), handoffCount: null }),
    composeAgent: () => delay({ name: SAMPLE_AGENT.name, role: SAMPLE_AGENT.role, tools: [...SAMPLE_AGENT.tools], droppedTools: [...SAMPLE_AGENT.droppedTools] }),
  };
}
