/**
 * BRA-P0-09b — kanıt paketi üreticisi (salt-okur, türetilmiş).
 *
 * Bir koşunun DOĞRULANABİLİR kanıt paketi: makbuz referansı (04c + 03-N3 özetleri), kod ajanı
 * koşusunda commit SHA / PR bağlantısı / CI durumu, adım ve onay özeti, maliyet ve paketin kendi
 * SHA-256 özeti (`packHash`). Yeni tablo/kolon/yazma YOK; her şey mevcut satırlardan okuma anında türetilir.
 *
 * `buildEvidencePack` SAFTIR (I/O yok, saat yok): aynı girdi → aynı `packHash`. `packHash` paket gövdesinin
 * (kendisi hariç) kanonik JSON'unun SHA-256'sıdır; gövde makbuzun `contentHash`'ini içerir, böylece paket
 * makbuza bağlanır.
 *
 * Alan başına kaynak (`source`) ya da "kaynak yok" (`status:"unavailable"` + `reason`) açıktır. SHA/PR/CI
 * ASLA uydurulmaz: yalnız doğrulayıcıdan geçen değer yazılır (SHA = hex, PR = `canonicalPrUrl`, CI = bilinen
 * `mergeableState` kümesi). Ham araç çıktısı, diff/test metni, araç girdisi, onay açıklaması, adım gerekçesi
 * pakete GİRMEZ; yalnız yol/sayı/ref.
 */
import { createHash } from "node:crypto";
import type { JobReceipt } from "@ai-company-os/core";
import { canonicalPrUrl } from "./receipt";
import type { ReceiptDiffSummary, ReceiptTestSummary } from "./code-summary";

export const EVIDENCE_PACK_VERSION = 1;
/** Paket araçları: commit (git_commit), PR (create_pull_request dry-run/gerçek), CI proxy (PR durum sorgusu). */
export const EVIDENCE_PACK_TOOL_NAMES = ["git_commit", "create_pull_request", "get_github_pr_status"] as const;
export const MAX_PACK_CALLS = 200;
export const MAX_PACK_STEPS = 200;
export const MAX_PACK_APPROVALS = 100;
export const MAX_PACK_COMMITS = 50;
const MAX_NAME = 100;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export type PackRef<T> =
  | { status: "available"; value: T; source: string }
  | { status: "unavailable"; value: null; source: null; reason: string };

const available = <T>(value: T, source: string): PackRef<T> => ({ status: "available", value, source });
const unavailable = (reason: string): PackRef<never> => ({ status: "unavailable", value: null, source: null, reason });

export interface PackToolCall {
  id: string;
  toolName: string;
  status: string;
  output?: unknown;
}
export interface PackStepRow {
  stepIndex: number;
  name: string;
  status: string;
  costUsd?: unknown;
  startedAt?: Date | null;
  completedAt?: Date | null;
}
export interface PackApprovalRow {
  id: string;
  type: string;
  status: string;
  decidedBy?: string | null;
  decidedAt?: Date | null;
  createdAt: Date;
  amountUsd?: unknown;
}

export interface EvidencePackInput {
  runId: string;
  receipt: JobReceipt;
  /** `runs.cost_usd` (makbuzdaki maliyetten ayrı kaynak). */
  runCostUsd: unknown;
  steps: readonly PackStepRow[];
  approvals: readonly PackApprovalRow[];
  /** Yalnız `EVIDENCE_PACK_TOOL_NAMES` araçları; sıra: eskiden yeniye. */
  calls: readonly PackToolCall[];
  summaries: { testSummary: ReceiptTestSummary | null; diffSummary: ReceiptDiffSummary | null };
  truncated: { calls: boolean; steps: boolean; approvals: boolean; /** diff/test özet sorgusu kırpıldı */ summaryCalls?: boolean };
}

export interface EvidencePack {
  version: number;
  runId: string;
  receipt: {
    id: string;
    outcome: string;
    resultStatus: string | null;
    contentHash: string;
    createdAt: string;
    /** `kind` başına makbuz kanıt öğesi sayısı (içerik değil). */
    evidenceCounts: Record<string, number>;
    approvalIds: string[];
  };
  cost: { receiptUsd: number | null; runUsd: number | null };
  code: {
    commits: PackRef<Array<{ sha: string; ref: string }>>;
    pullRequest: PackRef<{ url: string }>;
    ci: PackRef<{ mergeStateProxy: "mergeable_clean" | "mergeable_unstable" | "unknown"; mergeableState: string; headSha: string; note: string }>;
    diff: PackRef<ReceiptDiffSummary>;
    tests: PackRef<ReceiptTestSummary>;
  };
  steps: Array<{ stepIndex: number; name: string; status: string; costUsd: number | null; startedAt: string | null; completedAt: string | null }>;
  approvals: Array<{ id: string; type: string; status: string; amountUsd: number | null; decidedBy: string | null; decidedAt: string | null; createdAt: string }>;
  truncated: boolean;
  truncatedParts: { toolCalls: boolean; toolCallSummary: boolean; steps: boolean; approvals: boolean; commits: boolean };
  /** SHA-256 hex: yukarıdaki alanların (bu alan hariç) kanonik JSON'u. */
  packHash: string;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (d: Date | null | undefined): string | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);
const cleanName = (v: unknown): string => {
  const t = typeof v === "string" ? v.trim().replace(/[\u0000-\u001f\u007f]/g, " ") : "";
  return t.length > MAX_NAME ? t.slice(0, MAX_NAME) : t;
};

/** Anahtarları sıralı JSON: aynı veri → aynı bayt dizisi. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

function shaOf(output: unknown): string | null {
  const o = asRecord(output);
  if (!o) return null;
  const commit = asRecord(o.commit);
  if (o.status === "FAILED" || o.error) return null;
  for (const c of [o.sha, o.commit_sha, commit?.sha]) {
    if (typeof c === "string" && SHA_RE.test(c)) return c.toLowerCase();
  }
  return null;
}

function deriveCommits(calls: readonly PackToolCall[]): { ref: PackRef<Array<{ sha: string; ref: string }>>; capped: boolean } {
  const git = calls.filter((c) => c.toolName.toLowerCase() === "git_commit" && c.status === "COMPLETED");
  if (git.length === 0) return { ref: unavailable("git_commit aracı çağrısı yok"), capped: false };
  const seen = new Set<string>();
  const out: Array<{ sha: string; ref: string }> = [];
  for (const c of git) {
    const sha = shaOf(c.output);
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    out.push({ sha, ref: `tool_call:${c.id}` });
  }
  if (out.length === 0) return { ref: unavailable("git_commit çıktısında geçerli SHA yok"), capped: false };
  return { ref: available(out.slice(0, MAX_PACK_COMMITS), "tool_calls:git_commit"), capped: out.length > MAX_PACK_COMMITS };
}

function derivePr(receipt: JobReceipt, calls: readonly PackToolCall[]): PackRef<{ url: string }> {
  // Makbuz PR öğesi zaten `canonicalPrUrl` + "girdide geçen URL kanıt değil" kurallarından geçmiştir.
  for (const e of receipt.evidence) {
    const url = e.kind === "pr" ? canonicalPrUrl(e.ref) : null;
    if (url) return available({ url }, "receipt.evidence:pr");
  }
  const pc = calls.filter((c) => c.toolName.toLowerCase() === "create_pull_request");
  if (pc.length === 0) return unavailable("create_pull_request aracı çağrısı yok");
  if (pc.some((c) => asRecord(c.output)?.dryRun === true)) return unavailable("yalnız dry-run: gerçek PR açılmadı");
  return unavailable("PR aracı çağrısında doğrulanmış PR bağlantısı yok");
}

const MERGE_PROXY: Record<string, "mergeable_clean" | "mergeable_unstable"> = { clean: "mergeable_clean", unstable: "mergeable_unstable" };
const CI_NOTE = "gerçek check-run/CI verisi yok; yalnız GitHub mergeable_state vekili (dal koruması yoksa kırmızı CI'da bile clean olabilir)";

/**
 * CI: gerçek check-run verisi YOK. Tek kaynak, makbuzdaki PR'a ait EN YENİ `get_github_pr_status` çıktısının
 * `mergeableState` alanıdır (vekil). En yeni çağrı PR URL'si, `open` durumu ve paketteki commit SHA'sıyla
 * eşleşmezse bayat eski çağrıya DÜŞÜLMEZ: `unavailable`.
 */
function deriveCi(pr: PackRef<{ url: string }>, commitShas: readonly string[], calls: readonly PackToolCall[]): EvidencePack["code"]["ci"] {
  const sc = calls.filter((c) => c.toolName.toLowerCase() === "get_github_pr_status" && c.status === "COMPLETED");
  if (sc.length === 0) return unavailable("PR durum sorgusu (get_github_pr_status) çağrısı yok; gerçek CI verisi de yok");
  if (pr.status !== "available") return unavailable("makbuzda doğrulanmış PR yok; durum sorgusu bir PR'a bağlanamadı");
  const latest = sc[sc.length - 1]!;
  const p = asRecord(asRecord(latest.output)?.pr);
  if (!p || canonicalPrUrl(p.url) !== pr.value.url) return unavailable("en yeni durum çağrısı makbuzdaki PR ile eşleşmiyor");
  if (typeof p.state !== "string" || p.state.toLowerCase() !== "open") return unavailable("en yeni durum çağrısında PR açık (open) değil");
  const head = typeof p.headSha === "string" && SHA_RE.test(p.headSha) ? p.headSha.toLowerCase() : null;
  if (!head || !commitShas.some((s) => s === head || (s.length >= 7 && head.length >= 7 && (s.startsWith(head) || head.startsWith(s))))) {
    return unavailable("PR headSha paketteki commit SHA'larıyla eşleşmiyor");
  }
  const ms = typeof p.mergeableState === "string" ? p.mergeableState.toLowerCase() : "";
  const proxy = Object.prototype.hasOwnProperty.call(MERGE_PROXY, ms) ? MERGE_PROXY[ms]! : "unknown";
  return available({ mergeStateProxy: proxy, mergeableState: proxy === "unknown" ? "unknown" : ms, headSha: head, note: CI_NOTE }, `tool_call:${latest.id}`);
}

export function buildEvidencePack(input: EvidencePackInput): EvidencePack {
  const { receipt, summaries } = input;
  const evidenceCounts: Record<string, number> = {};
  for (const e of receipt.evidence) evidenceCounts[e.kind] = (evidenceCounts[e.kind] ?? 0) + 1;

  const commits = deriveCommits(input.calls);
  const pullRequest = derivePr(receipt, input.calls);
  const ci = deriveCi(pullRequest, commits.ref.status === "available" ? commits.ref.value.map((c) => c.sha) : [], input.calls);

  const steps = input.steps.slice(0, MAX_PACK_STEPS).map((s) => ({
    stepIndex: s.stepIndex,
    name: cleanName(s.name),
    status: s.status,
    costUsd: num(s.costUsd),
    startedAt: iso(s.startedAt),
    completedAt: iso(s.completedAt),
  }));
  const approvals = input.approvals.slice(0, MAX_PACK_APPROVALS).map((a) => ({
    id: a.id,
    type: a.type,
    status: a.status,
    amountUsd: num(a.amountUsd),
    decidedBy: a.decidedBy ?? null,
    decidedAt: iso(a.decidedAt),
    createdAt: iso(a.createdAt) ?? "",
  }));

  const truncatedParts = {
    toolCalls: input.truncated.calls,
    toolCallSummary: input.truncated.summaryCalls === true,
    steps: input.truncated.steps || input.steps.length > MAX_PACK_STEPS,
    approvals: input.truncated.approvals || input.approvals.length > MAX_PACK_APPROVALS,
    commits: commits.capped,
  };
  const body: Omit<EvidencePack, "packHash"> = {
    version: EVIDENCE_PACK_VERSION,
    runId: input.runId,
    receipt: {
      id: receipt.id,
      outcome: receipt.outcome,
      resultStatus: receipt.resultStatus,
      contentHash: receipt.contentHash,
      createdAt: receipt.createdAt,
      evidenceCounts,
      approvalIds: [...receipt.approvalIds].sort(),
    },
    cost: { receiptUsd: receipt.costUsd, runUsd: num(input.runCostUsd) },
    code: {
      commits: commits.ref,
      pullRequest,
      ci,
      diff: summaries.diffSummary ? available(summaries.diffSummary, "tool_calls:diff-tools") : unavailable("diff aracı çağrısı/çıktısı yok"),
      tests: truncatedParts.toolCallSummary ? unavailable("truncated: test çağrı sorgusu kırpıldı, sonuç doğrulanamaz") : summaries.testSummary ? available(summaries.testSummary, "tool_calls:test-tools") : unavailable("test aracı çağrısı yok"),
    },
    steps,
    approvals,
    truncated: Object.values(truncatedParts).some(Boolean),
    truncatedParts,
  };
  const packHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, packHash };
}
