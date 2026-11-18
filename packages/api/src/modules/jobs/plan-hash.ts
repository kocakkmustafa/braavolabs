/**
 * BRA-P0-03b — planHash: kullanıcının gördüğü plan kartı ile başlatılan işin
 * AYNI olduğunu bağlar (exact-action mantığı, BRA-P0-05 `canonicalize`).
 *
 * Sunucu taraflı HMAC-SHA256. Anahtar, mevcut ana anahtardan (JWT_SECRET)
 * HKDF ile ayrı bir `info` dizgesiyle türetilir (manifest imzasındaki kalıp);
 * yeni sır eklenmez. Hash şunlara bağlıdır: tenant, workspace, mesajın özeti ve
 * kartın DETERMİNİSTİK alanları (goal, sources, steps, estimate, risk,
 * approvals, budget). `title` (LLM önerebilir) ve `warnings` dışarıda tutulur:
 * yürütme yolunu etkilemezler, LLM'siz yeniden üretimde farklılaşabilirler.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { canonicalize } from "../approval/exact-action";
import type { PlanCard } from "./plan";

export const PLAN_HASH_VERSION = 1;
const HKDF_INFO = "braavolabs-job-plan-hash-v1";

function deriveKey(): Buffer {
  const master = env.JWT_SECRET;
  if (!master || master.length < 32) throw new Error("plan hash key unavailable");
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.from("job-plan", "utf8"), HKDF_INFO, 32));
}

export interface PlanHashInput {
  tenantId: string;
  workspaceId: string | null;
  message: string;
  card: PlanCard;
}

/** `v1:<hmac-sha256 hex>`. */
export function computePlanHash(input: PlanHashInput): string {
  const { card } = input;
  const body = canonicalize({
    v: PLAN_HASH_VERSION,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    message: createHash("sha256").update(input.message.trim(), "utf8").digest("hex"),
    card: {
      goal: card.goal,
      sources: card.sources,
      steps: card.steps,
      estimate: card.estimate,
      risk: card.risk,
      approvals: card.approvals,
      budget: card.budget,
    },
  });
  return `v${PLAN_HASH_VERSION}:${createHmac("sha256", deriveKey()).update(body).digest("hex")}`;
}

/** Sabit zamanlı karşılaştırma; biçim bozuksa false. */
export function planHashMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
