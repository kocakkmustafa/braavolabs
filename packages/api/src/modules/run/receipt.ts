/**
 * BRA-P0-04c — İş makbuzu (job receipt) yazıcı ve okuma görünümü.
 *
 * Talimat §6.4 senaryo 7: "bu repodaki hatayı düzelt" işinin makbuzunda diff,
 * test sonucu ve PR bağlantısı yoksa `VERIFIED` işaretlenmez.
 *
 * `buildReceipt` SAFTIR (I/O yok, saat yok). `resultStatus` kararını
 * `deriveResultStatus`'a (job-state.ts) bırakır; burada yalnız kanıt öğeleri
 * ve "bu iş kod/PR gerektiriyor mu" sorusu üretilir. Çelişki olursa
 * `deriveResultStatus` ana kabul edilir (bu dosya ondan farklı karar vermez).
 *
 * Kanıt = koşunun `tool_calls` kayıtlarından türeyen REFERANS öğeleri
 * (tür + `tool_call:<id>` ya da kısa https URL). E-posta gövdesi, anahtar,
 * ham çıktı makbuza ASLA girmez; çıktı yalnız "test geçti mi" ve "PR URL'si
 * var mı" sorularını yanıtlamak için okunur ve atılır.
 *
 * `writeReceipt` idempotenttir: aynı (koşu, sonuç durumu) için ikinci satır
 * yazılmaz. Tablo append-only'dir (UPDATE/DELETE yok), bu yüzden sonradan
 * düzeltme değil, yeni sonuç (FAILED → yeniden dene → COMPLETED) yeni satır olur.
 */
import { createHash } from "node:crypto";
import type { JobReceipt, JobReceiptEvidence, JobReceiptEvidenceKind } from "@ai-company-os/core";
import { deriveResultStatus, type JobState, type ResultStatus } from "./job-state";

/** Makbuz yazılan sonuç durumları. */
export const RECEIPT_OUTCOMES = ["COMPLETED", "FAILED", "CANCELLED"] as const satisfies readonly JobState[];
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];
export const isReceiptOutcome = (s: JobState): s is ReceiptOutcome =>
  (RECEIPT_OUTCOMES as readonly string[]).includes(s);

/** Kod/PR gerektiren işte VERIFIED için şart olan kanıt türleri. */
export const CODE_JOB_REQUIRED_KINDS: readonly JobReceiptEvidenceKind[] = ["diff", "test", "pr"];

const MAX_EVIDENCE = 50;
const MAX_REF = 200;

export interface ReceiptToolCall {
  id: string;
  toolName: string;
  status: string;
  output?: unknown;
}

export interface ReceiptRunInput {
  id: string;
  tenantId: string;
  /** Sonuç durumu (COMPLETED | FAILED | CANCELLED). */
  outcome: ReceiptOutcome;
  costUsd?: unknown;
  /** Koşu girdisi: yalnız "kod işi mi" boolean'ı için okunur, makbuza girmez. */
  input?: unknown;
  steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<ReceiptToolCall> }>;
  approvals?: ReadonlyArray<{ id: string }>;
}

export interface ReceiptDraft {
  runId: string;
  tenantId: string;
  outcome: ReceiptOutcome;
  resultStatus: ResultStatus | null;
  costUsd: number | null;
  evidence: JobReceiptEvidence[];
  approvalIds: string[];
  contentHash: string;
}

// ── Kanıt türü sınıflandırma (araç adından) ───────────────────────────────
const RE_PR = /pull_?request|create_?pr|open_?pr|merge_?request/;
const RE_TEST = /(^|[^a-z])tests?([^a-z]|$)|pytest|jest|vitest|unittest/;
const RE_DIFF = /diff|patch|commit|push_?files|create_or_update_file|edit_?file|write_?file|str_?replace/;
const RE_ARTIFACT = /artifact|upload|export_?file/;

function classifyTool(toolName: string): JobReceiptEvidenceKind | null {
  const n = toolName.toLowerCase();
  if (RE_PR.test(n)) return "pr";
  if (RE_TEST.test(n)) return "test";
  if (RE_DIFF.test(n)) return "diff";
  if (RE_ARTIFACT.test(n)) return "artifact";
  return null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Test aracı çıktısı AÇIKÇA geçtiğini söylüyorsa true; belirsizse false (fail-closed). */
function testPassed(output: unknown): boolean {
  const o = asRecord(output);
  if (!o) return false;
  const exit = o.exitCode ?? o.exit_code;
  if (typeof exit === "number") return exit === 0 && !(Number(o.failed) > 0) && !(Number(o.failures) > 0);
  if (o.passed === true || o.success === true) return !(Number(o.failed) > 0) && !(Number(o.failures) > 0);
  return false;
}

/** PR URL'si: yalnız https, sorgu/parça atılır (token sızdırmasın), kısa. */
function prUrl(output: unknown): string | null {
  const o = asRecord(output);
  if (!o) return null;
  for (const key of ["html_url", "url", "pr_url", "pull_request_url"]) {
    const v = o[key];
    if (typeof v !== "string") continue;
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" || u.username || u.password) continue;
      const clean = `${u.origin}${u.pathname}`;
      if (clean.length <= MAX_REF) return clean;
    } catch {
      /* bozuk URL: kanıt sayılmaz */
    }
  }
  return null;
}

/** Girdi metninde kod/PR işi izi var mı? (yalnız boolean; metin saklanmaz) */
const RE_CODE_JOB = /düzelt|\bbug\b|\bfix\b|refactor|pull request|\bpr\b|\brepo\b|\bcommit\b/i;
function looksLikeCodeJob(input: unknown, evidenceAttempted: boolean): boolean {
  if (evidenceAttempted) return true;
  let text = "";
  try {
    text = JSON.stringify(input ?? "").slice(0, 4000);
  } catch {
    return false;
  }
  return RE_CODE_JOB.test(text);
}

export function deriveEvidence(steps: ReceiptRunInput["steps"]): { evidence: JobReceiptEvidence[]; codeToolUsed: boolean } {
  const evidence: JobReceiptEvidence[] = [];
  let codeToolUsed = false;
  for (const step of steps) {
    for (const tc of step.toolCalls ?? []) {
      const kind = classifyTool(tc.toolName ?? "");
      if (!kind) continue;
      if (kind !== "artifact") codeToolUsed = true;
      const completed = tc.status === "COMPLETED";
      if (kind === "test") {
        // Başarısız/çalışmayan test de listelenir: ok:false, VERIFIED'ı veto eder.
        evidence.push({ kind, ref: `tool_call:${tc.id}`, ok: completed && testPassed(tc.output) });
      } else if (!completed) {
        continue;
      } else if (kind === "pr") {
        const url = prUrl(tc.output);
        if (url) evidence.push({ kind, ref: url });
      } else {
        evidence.push({ kind, ref: `tool_call:${tc.id}` });
      }
      if (evidence.length >= MAX_EVIDENCE) return { evidence, codeToolUsed };
    }
  }
  return { evidence, codeToolUsed };
}

function stableHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildReceipt(run: ReceiptRunInput): ReceiptDraft {
  const { evidence, codeToolUsed } = deriveEvidence(run.steps);
  const requiredKinds = looksLikeCodeJob(run.input, codeToolUsed) ? CODE_JOB_REQUIRED_KINDS : [];
  // deriveResultStatus: COMPLETED dışında null; kanıt yoksa UNVERIFIED (fail-closed).
  const resultStatus = deriveResultStatus(run.outcome, requiredKinds, evidence);
  const cost = run.costUsd === null || run.costUsd === undefined ? NaN : Number(run.costUsd);
  const costUsd = Number.isFinite(cost) ? cost : null;
  const approvalIds = (run.approvals ?? []).map((a) => a.id).sort();
  const contentHash = stableHash({
    runId: run.id,
    tenantId: run.tenantId,
    outcome: run.outcome,
    resultStatus,
    costUsd,
    evidence,
    approvalIds,
  });
  return { runId: run.id, tenantId: run.tenantId, outcome: run.outcome, resultStatus, costUsd, evidence, approvalIds, contentHash };
}

/** `writeReceipt`'in ihtiyaç duyduğu dilim (transaction ya da prisma; testler sahteler). */
export interface ReceiptClient {
  run: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): PromiseLike<any>;
  };
  jobReceipt?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): PromiseLike<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(args: any): PromiseLike<any>;
  };
}

export type WriteReceiptResult =
  | { written: true; id: string; resultStatus: ResultStatus | null }
  | { written: false; reason: "exists" | "run_not_found" | "no_client" };

/**
 * Makbuzu yazar. Çağıran yalnız geçişi KAZANDIKTAN sonra çağırır (CAS kaybında
 * çağrılmaz). Tenant kapsamı okuma sorgusunda (`pipeline→company→tenantId`).
 */
export async function writeReceipt(
  client: ReceiptClient,
  runId: string,
  outcome: ReceiptOutcome,
  tenantId: string,
): Promise<WriteReceiptResult> {
  const store = client.jobReceipt;
  if (!store) return { written: false, reason: "no_client" };
  const existing = await store.findFirst({ where: { runId, tenantId, outcome }, select: { id: true } });
  if (existing) return { written: false, reason: "exists" };

  const run = await client.run.findFirst({
    where: { id: runId, pipeline: { company: { tenantId } } },
    select: {
      costUsd: true,
      input: true,
      approvals: { select: { id: true } },
      steps: { select: { toolCalls: { select: { id: true, toolName: true, status: true, output: true } } } },
    },
  });
  if (!run) return { written: false, reason: "run_not_found" };

  const draft = buildReceipt({
    id: runId,
    tenantId,
    outcome,
    costUsd: run.costUsd,
    input: run.input,
    steps: run.steps ?? [],
    approvals: run.approvals ?? [],
  });
  const row = await store.create({
    data: {
      runId,
      tenantId,
      outcome: draft.outcome,
      resultStatus: draft.resultStatus,
      costUsd: draft.costUsd,
      evidence: draft.evidence,
      approvalIds: draft.approvalIds,
      contentHash: draft.contentHash,
    },
    select: { id: true },
  });
  return { written: true, id: row.id, resultStatus: draft.resultStatus };
}

/** DB satırı → API yanıtı (`JobReceipt` tipi; ham satır/Company.config yok). */
export function toJobReceiptDto(row: {
  id: string;
  runId: string;
  tenantId: string;
  outcome: string;
  resultStatus: string | null;
  costUsd: unknown;
  evidence: unknown;
  approvalIds: string[];
  contentHash: string;
  createdAt: Date;
}): JobReceipt {
  const cost = row.costUsd === null || row.costUsd === undefined ? NaN : Number(row.costUsd);
  return {
    id: row.id,
    runId: row.runId,
    tenantId: row.tenantId,
    outcome: row.outcome as JobReceipt["outcome"],
    resultStatus: row.resultStatus as JobReceipt["resultStatus"],
    costUsd: Number.isFinite(cost) ? cost : null,
    evidence: Array.isArray(row.evidence) ? (row.evidence as JobReceiptEvidence[]) : [],
    approvalIds: row.approvalIds ?? [],
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
  };
}
