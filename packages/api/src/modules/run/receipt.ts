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
 * İdempotency: TEK GARANTİ "yalnız geçişi (CAS) kazanan çağrı yazar" — aynı kenarı
 * iki çağrı kazanamaz (transition.ts). `writeReceipt`'teki önce-oku yalnız ikinci
 * emniyettir: aynı (koşu, kiracı, sonuç, contentHash) varsa yazmaz. `contentHash`
 * `attempt`'i (`retry_count`) ve maliyeti/kanıtı içerir; FAILED → yeniden dene →
 * FAILED ikinci makbuzu üretir (retry çalıştırması maliyet ya da kanıt değiştirir;
 * hiçbiri değişmediyse ve retry_count artmadıysa ikinci satır atlanır, kabul edilmiş
 * sınır). GET en son satırı (createdAt desc) verir. "Append-only" yalnız KURALDIR:
 * tabloda UPDATE/DELETE'i engelleyen DB zorlaması yok.
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
  /** Yeniden deneme sayacı (attempt ayrımcısı; `runs.retry_count`). */
  retryCount?: number | null;
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

// ── Kanıt türü: SABİT İZİN LİSTESİ (tam eşleşme, küçük harf) ───────────────
// Alt dize/regex eşleşmesi yok: `create_product`, `send_test_email`, `open_project`
// gibi adlar kanıt üretmez. Kod tabanındaki gerçek araç kaydında (agent/registry.ts)
// yalnız `get_github_pr_status` (PR URL'si döner, salt-okur) kod kanıtıyla ilgilidir;
// diff/test/PR-oluşturma araçları harici (MCP/bağlı sağlayıcı) araçlardır ve burada
// bilinen adlarıyla listelenir. Yeni araç = bu listeye bilinçli ekleme.
export const EVIDENCE_TOOLS: Readonly<Record<string, JobReceiptEvidenceKind>> = {
  get_github_pr_status: "pr",
  create_pull_request: "pr",
  git_commit: "diff",
  git_diff: "diff",
  apply_patch: "diff",
  push_files: "diff",
  create_or_update_file: "diff",
  write_file: "diff",
  edit_file: "diff",
  run_tests: "test",
  run_test_suite: "test",
  pytest: "test",
};
/** Veritabanında yalnız bu araçların çıktısı okunur (ağır `output` taraması dar tutulur). */
export const EVIDENCE_TOOL_NAMES: readonly string[] = Object.keys(EVIDENCE_TOOLS);

function classifyTool(toolName: string): JobReceiptEvidenceKind | null {
  const n = String(toolName ?? "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(EVIDENCE_TOOLS, n) ? EVIDENCE_TOOLS[n]! : null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Test aracı çıktısı AÇIKÇA geçtiğini söylüyorsa true; belirsizse/başarısızsa false (veto). */
function testPassed(output: unknown): boolean {
  const o = asRecord(output);
  if (!o) return false;
  const noFailures = !(Number(o.failed) > 0) && !(Number(o.failures) > 0);
  const exit = o.exitCode ?? o.exit_code;
  if (typeof exit === "number") return exit === 0 && noFailures;
  if (o.passed === true) return noFailures;
  return false;
}

const PR_PATH: Record<string, RegExp> = {
  "github.com": /^\/[^/]+\/[^/]+\/pull\/\d+$/,
  "gitlab.com": /^\/.+\/merge_requests\/\d+$/,
  "bitbucket.org": /^\/[^/]+\/[^/]+\/pull-requests\/\d+$/,
};

/** Kanonik PR URL'si (https, bilinen host, PR yol biçimi, sorgu/parça yok) ya da null. */
export function canonicalPrUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    const re = PR_PATH[u.hostname.toLowerCase()];
    if (!re || !re.test(u.pathname)) return null;
    const clean = `${u.origin}${u.pathname}`;
    return clean.length <= MAX_REF ? clean : null;
  } catch {
    return null;
  }
}

/** Araç ÇIKTISINDAN PR URL'si; kullanıcı girdisinde aynen geçen URL kanıt sayılmaz. */
function prUrl(output: unknown, inputText: string): string | null {
  const o = asRecord(output);
  if (!o) return null;
  const nested = asRecord(o.pr);
  const candidates = [o.html_url, o.url, o.web_url, o.pr_url, o.pull_request_url, nested?.html_url, nested?.url, nested?.web_url];
  for (const c of candidates) {
    const clean = canonicalPrUrl(c);
    if (clean && !inputText.includes(clean.toLowerCase())) return clean;
  }
  return null;
}

/** Kod işi anahtar kelimeleri: geniş, fail-closed (yanlış pozitif = daha sıkı kural). */
const RE_CODE_JOB = /düzelt|\bbug|\bfix|hata|çöz|implement|refactor|\brepo|commit|\bpr\b|patch|\bkod/i;
function inputToText(input: unknown): string {
  try {
    return JSON.stringify(input ?? "") ?? "";
  } catch {
    return "";
  }
}
function looksLikeCodeJob(inputText: string, codeToolUsed: boolean): boolean {
  return codeToolUsed || RE_CODE_JOB.test(inputText);
}

const KIND_PRIORITY: Record<string, number> = { test: 0, pr: 1, diff: 2 };

/**
 * TÜM tool_call'lar taranır (veto kaçmasın); yalnız SAKLANAN öğe sayısı sınırlıdır.
 * `all` karar için, `stored` makbuza yazılan (başarısız testler ve her türün ilk
 * örneği önde) listedir.
 */
export function deriveEvidence(
  steps: ReceiptRunInput["steps"],
  inputText = "",
): { all: JobReceiptEvidence[]; stored: JobReceiptEvidence[]; codeToolUsed: boolean } {
  const all: JobReceiptEvidence[] = [];
  let codeToolUsed = false;
  for (const step of steps) {
    for (const tc of step.toolCalls ?? []) {
      const kind = classifyTool(tc.toolName);
      if (!kind) continue;
      codeToolUsed = true; // izinli kod aracı çağrıldı → kod işi (fail-closed)
      const completed = tc.status === "COMPLETED";
      if (kind === "test") {
        all.push({ kind, ref: `tool_call:${tc.id}`, ok: completed && testPassed(tc.output) });
      } else if (!completed) {
        continue;
      } else if (kind === "pr") {
        const url = prUrl(tc.output, inputText);
        if (url) all.push({ kind, ref: url });
      } else {
        all.push({ kind, ref: `tool_call:${tc.id}` });
      }
    }
  }
  const seen = new Set<string>();
  const rank = (e: JobReceiptEvidence): number => {
    if (e.kind === "test" && e.ok === false) return 0;
    if (!seen.has(e.kind)) {
      seen.add(e.kind);
      return 1 + (KIND_PRIORITY[e.kind] ?? 3);
    }
    return 10;
  };
  const ranked = all.map((e, i) => ({ e, i, r: rank(e) }));
  ranked.sort((x, y) => x.r - y.r || x.i - y.i);
  const stored = ranked.slice(0, MAX_EVIDENCE).sort((x, y) => x.i - y.i).map((x) => x.e);
  return { all, stored, codeToolUsed };
}

function stableHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildReceipt(run: ReceiptRunInput): ReceiptDraft {
  const inputText = inputToText(run.input);
  const { all, stored: evidence, codeToolUsed } = deriveEvidence(run.steps, inputText.toLowerCase());
  const requiredKinds = looksLikeCodeJob(inputText, codeToolUsed) ? CODE_JOB_REQUIRED_KINDS : [];
  // deriveResultStatus ana kabul: COMPLETED dışında null; kanıt yoksa UNVERIFIED (fail-closed).
  // Karar TÜM kanıttan verilir (50. sonrası başarısız test de veto eder).
  const resultStatus = deriveResultStatus(run.outcome, requiredKinds, all);
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
    attempt: run.retryCount ?? 0,
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
  const run = await client.run.findFirst({
    where: { id: runId, pipeline: { company: { tenantId } } },
    select: {
      costUsd: true,
      input: true,
      retryCount: true,
      approvals: { select: { id: true } },
      // Yalnız izinli kanıt araçlarının satırları (ağır `output` taraması dar tutulur).
      steps: {
        select: {
          toolCalls: {
            where: { toolName: { in: EVIDENCE_TOOL_NAMES } },
            select: { id: true, toolName: true, status: true, output: true },
          },
        },
      },
    },
  });
  if (!run) return { written: false, reason: "run_not_found" };

  const draft = buildReceipt({
    id: runId,
    tenantId,
    outcome,
    costUsd: run.costUsd,
    retryCount: run.retryCount,
    input: run.input,
    steps: run.steps ?? [],
    approvals: run.approvals ?? [],
  });
  const existing = await store.findFirst({
    where: { runId, tenantId, outcome, contentHash: draft.contentHash },
    select: { id: true },
  });
  if (existing) return { written: false, reason: "exists" };
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
