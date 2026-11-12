/**
 * BRA-UX-API-02 — GET /companies/:id/models (salt-okur model + yetki dökümü).
 *
 * Kaynaklar (migration yok): Agent.model (şirket ajanlarının SEÇİLİ modeli),
 * RunStep.costUsd (ajan adımı başına maliyet; ajanın MEVCUT modeline atfedilir),
 * UserAIConfig (kiracının sağlayıcı satırı; YALNIZ provider/model/anahtar-var-mı).
 * Şifreli anahtar, baseUrl ve ham kimlik bilgisi hiçbir koşulda yanıta girmez.
 *
 * Kiracı kapsamı çok halkalı: şirket {id, tenantId} ile router'da doğrulanır; ajan ve adım
 * sorguları ayrıca company.tenantId ile kısıtlanır.
 */
import type { ModelOverviewItem, ModelsOverview, ModelSource } from "@ai-company-os/core";
import { prisma } from "../../lib/db";
import {
  PROVIDER_MODELS,
  LOCAL_PROVIDERS,
  isModelCompatibleWithProvider,
  type AIProviderType,
} from "../../services/ai-client";

const SCALE = 6;

/** UTC ay başı (00:00:00.000). */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Decimal/string/number -> mikro-dolar BigInt. 6 haneden fazlası YUVARLANIR (toFixed).
 * Üstel biçimli number/string ("1e-7") Number üzerinden güvenle işlenir; sayı olmayan -> 0n.
 */
export function toMicro(v: unknown): bigint {
  let s: string;
  if (v && typeof (v as { toFixed?: unknown }).toFixed === "function") {
    s = (v as { toFixed: (n: number) => string }).toFixed(SCALE);
  } else if (typeof v === "number" || (typeof v === "string" && /e/i.test(v))) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0n;
    s = n.toFixed(SCALE);
  } else {
    s = String(v);
  }
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) return 0n;
  const frac = (m[3] ?? "").padEnd(SCALE + 1, "0");
  let n = BigInt(m[2]) * 10n ** BigInt(SCALE) + BigInt(frac.slice(0, SCALE));
  if (frac.charCodeAt(SCALE) >= 53) n += 1n; // 7. hane >= 5 -> yukarı yuvarla
  return m[1] === "-" ? -n : n;
}

export function microToText(n: bigint): string {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const base = 10n ** BigInt(SCALE);
  return `${neg ? "-" : ""}${a / base}.${(a % base).toString().padStart(SCALE, "0")}`;
}

const SAFE_MODEL_ID = /^[\w.:/-]{1,100}$/;
/** Anahtar benzeri önekler (ayraçlı: sk-, gsk_, csk-, xai-, pplx-, nvapi-, gh*_, rk/pk) ve sabit biçimler. */
const SECRET_PREFIX =
  /^((g?sk|csk|xai|pplx|nvapi|rk|pk|ghp|gho|ghu|ghs|ghr)[-_]|xox[abprs]|AKIA[0-9A-Z]{8,}|AIza[\w-]{10,}|eyJ)/i;

/** Model alanına yapıştırılmış anahtar benzeri değer mi? (≥32 karışık harf+rakam dizisi dahil) */
export function isSecretLike(id: string): boolean {
  if (SECRET_PREFIX.test(id)) return true;
  const run = /[A-Za-z0-9]{32,}/.exec(id);
  return !!run && /[A-Za-z]/.test(run[0]) && /\d/.test(run[0]);
}

function inferProvider(model: string): AIProviderType | null {
  for (const p of Object.keys(PROVIDER_MODELS) as AIProviderType[]) {
    if (LOCAL_PROVIDERS.has(p) || p === "OPENROUTER") continue;
    if (isModelCompatibleWithProvider(p, model)) return p;
  }
  return null;
}

interface StepAggRow {
  agent_id: string;
  cost: unknown;
  runs: bigint | number | string;
}

export async function buildModelsOverview(
  tenantId: string,
  companyId: string,
  now: Date = new Date(),
): Promise<ModelsOverview> {
  const from = monthStartUtc(now);

  // Sonuç satır sayısı ajan sayısıyla sınırlı; parametreli ($1..$4), enjeksiyon yok.
  // Önerilen indeks run_steps(agent_id, created_at) ayrı onaylı migration ile (bu bilet yapmaz).
  const [agents, configs, stepRows] = await Promise.all([
    prisma.agent.findMany({
      where: { companyId, company: { tenantId } },
      select: { id: true, model: true },
    }),
    prisma.userAIConfig.findMany({
      where: { tenantId },
      select: { provider: true, model: true, isDefault: true, encryptedApiKey: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    prisma.$queryRaw<StepAggRow[]>`
      SELECT rs.agent_id AS agent_id,
             SUM(rs.cost_usd) AS cost,
             COUNT(DISTINCT rs.run_id) AS runs
      FROM run_steps rs
      JOIN agents a ON a.id = rs.agent_id
      JOIN companies c ON c.id = a.company_id
      WHERE a.company_id = ${companyId}
        AND c.tenant_id = ${tenantId}
        AND rs.created_at >= ${from}
        AND rs.created_at <= ${now}
      GROUP BY rs.agent_id`,
  ]);

  const agentModel = new Map<string, string>();
  for (const a of agents) if (SAFE_MODEL_ID.test(a.model) && !isSecretLike(a.model)) agentModel.set(a.id, a.model);

  // Koşu sayısı ajan başına tekil; aynı koşuda iki ajan aynı modeli kullanırsa iki kez sayılabilir (belgelendi).
  const perModel = new Map<string, { micro: bigint; hasCost: boolean; runs: number }>();
  for (const id of new Set(agentModel.values())) perModel.set(id, { micro: 0n, hasCost: false, runs: 0 });
  for (const r of stepRows) {
    const model = agentModel.get(r.agent_id);
    const acc = model ? perModel.get(model) : undefined;
    if (!acc) continue;
    acc.runs += Number(r.runs);
    if (r.cost !== null && r.cost !== undefined) {
      acc.micro += toMicro(r.cost);
      acc.hasCost = true;
    }
  }

  const models: ModelOverviewItem[] = [...perModel.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, acc]) => {
      const compat = configs.filter((c) => isModelCompatibleWithProvider(c.provider as AIProviderType, id));
      const cloud = compat.filter((c) => !LOCAL_PROVIDERS.has(c.provider as AIProviderType));
      const local = compat.filter((c) => LOCAL_PROVIDERS.has(c.provider as AIProviderType));
      let provider: string | null = null;
      let source: ModelSource | null = null;
      if (cloud.length > 0) {
        // Bulut uyumu önek tabanlıdır (gerçek eşleşme).
        // Aynı kimlik birden çok bulut kataloğunda olabilir (ör. glm-4.7): anahtarı kayıtlı satır öncelikli.
        const keyed = cloud.find((c) => c.encryptedApiKey);
        provider = (keyed ?? cloud[0]).provider;
        source = keyed ? "byok" : null;
      } else if (local.length === 1) {
        // Katalog dışı kimlik: yerel sağlayıcı yalnız TEK aday varsa kabul edilir.
        provider = local[0].provider;
        source = "local";
      } else if (local.length === 0) {
        provider = inferProvider(id);
      } // local.length > 1: belirsiz -> provider/source null
      return {
        id,
        provider,
        source,
        access: { scope: "agent", mode: null },
        // Maliyet verisi hiç yazılmamışsa 0 uydurulmaz.
        costThisMonthUsd: acc.hasCost ? microToText(acc.micro) : null,
        runCountThisMonth: acc.runs,
      };
    });

  return {
    autoSelection: { enabled: null },
    models,
    generatedAt: now.toISOString(),
    costWindow: { from: from.toISOString(), to: now.toISOString() },
  };
}
