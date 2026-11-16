/**
 * BRA-P1-07-N2 — tek iş pilot senaryosu: "haftalık müşteri e-postası taslağı".
 *
 * Pure: no I/O, no clock, no randomness. Composes the existing pieces
 * (07a manifest projection + 07b synthetic data) into ONE fixed pilot package
 * and validates a package against the 07a schema, a pin to the scenario
 * snapshot, and an ALLOWLIST for the synthetic data. Contains no tenant/company
 * ids, credentials or real personal data.
 */

import { isDeepStrictEqual } from "node:util";
import type { CompanyTemplateSnapshot } from "../templates/templates.service";
import {
  microAppManifestSchema,
  toMicroAppManifest,
  type MicroAppManifest,
} from "../templates/micro-app-manifest";
import {
  generateSyntheticData,
  SYNTHETIC_MAX_COUNT,
  type SyntheticRecord,
} from "./synthetic-data";

export const PILOT_SCENARIO_ID = "haftalik-musteri-eposta-taslagi";
export const PILOT_SCENARIO_VERSION = "1.0.0";
export const PILOT_SCENARIO_SEED = 20260101;
export const PILOT_SCENARIO_COUNT = 12;

export interface PilotPackage {
  manifest: MicroAppManifest;
  syntheticData: SyntheticRecord[];
}

/** Rule codes: the first violated rule is reported as `PilotValidationError.rule`. */
export type PilotRule =
  | "package-shape"
  | "manifest-schema"
  | "manifest-secret"
  | "manifest-pin"
  | "data-shape"
  | "data-record-keys"
  | "data-id"
  | "data-name"
  | "data-company"
  | "data-status"
  | "data-amount"
  | "data-currency"
  | "data-date";

export class PilotValidationError extends Error {
  constructor(
    readonly rule: PilotRule,
    message: string,
  ) {
    super(`[${rule}] ${message}`);
    this.name = "PilotValidationError";
  }
}

/**
 * Template snapshot of the pilot job. Fresh object per call (no shared mutation).
 *
 * Notes (honest scope):
 * - `connector`/`scopes` in a tool entry become the manifest's `connectorRequests`.
 *   `drafts.create` is the REQUESTED ACTION (a label, not a Gmail OAuth scope);
 *   real enforcement happens at connector binding time. This scenario requests no
 *   send action, but "draft only" is guaranteed by the bound connector scope,
 *   not by this manifest.
 * - The cron string carries no time zone. The scheduler evaluates it in
 *   `SCHEDULER_TZ` (config/env.ts; default "UTC"), so "0 9 * * 1" is Monday
 *   09:00 UTC unless an operator sets another zone.
 */
export function pilotScenarioSnapshot(): CompanyTemplateSnapshot {
  return {
    name: "Haftalık müşteri e-postası taslağı",
    description:
      "Küçük işletme pilotu: haftalık müşteri e-postası taslağını sentetik müşteri verisinden hazırlar. Bu senaryo gönderim eylemi istemez; zorlama bağlayıcı kapsamına bağlıdır.",
    primitives: ["content"],
    agents: [
      {
        handle: "pilot-summarizer",
        name: "Müşteri Notu Derleyici",
        role: "summarizer",
        systemPrompt: "Haftanın müşteri kayıtlarını özetle.",
        model: "claude-sonnet",
        maxTokens: 2000,
        tools: [{ name: "read_customer_records" }],
      },
      {
        handle: "pilot-writer",
        name: "E-posta Taslak Yazarı",
        role: "writer",
        systemPrompt: "Özetten kısa ve nazik bir e-posta taslağı yaz.",
        model: "claude-sonnet",
        maxTokens: 3000,
        tools: [{ name: "draft_email", connector: "gmail", scopes: ["drafts.create"] }],
      },
    ],
    pipelines: [
      {
        name: "Haftalık taslak akışı",
        description: "Pazartesi sabahı müşteri notlarını derler ve e-posta taslağı hazırlar.",
        trigger: "SCHEDULED",
        schedule: "0 9 * * 1", // SCHEDULER_TZ (default UTC)
        pipelineType: "SEQUENTIAL",
        maxDelegationDepth: 0,
        steps: [
          { name: "Müşteri kayıtlarını oku", order: 1, agentRole: "summarizer" },
          { name: "Haftalık özeti çıkar", order: 2, agentRole: "summarizer" },
          { name: "E-posta taslağını yaz", order: 3, agentRole: "writer" },
        ],
        config: {},
      },
    ],
    memorySeeds: [],
  };
}

export function buildPilotPackage(
  opts: { seed?: number; count?: number } = {},
): PilotPackage {
  const manifest = toMicroAppManifest(pilotScenarioSnapshot(), {
    version: PILOT_SCENARIO_VERSION,
    syntheticDataRef: PILOT_SCENARIO_ID,
  });
  const syntheticData = generateSyntheticData({
    seed: opts.seed ?? PILOT_SCENARIO_SEED,
    count: opts.count ?? PILOT_SCENARIO_COUNT,
    kind: "customer",
  });
  return { manifest, syntheticData };
}

// ── Manifest secret/URL check (linear patterns, no nested quantifiers) ──
const SECRET_LIKE =
  /AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[0-9A-Za-z_-]{5,}|gh[pousr]_[0-9A-Za-z]+|github_pat_|xox[abprs]-|xapp-|whsec_|(?:^|[^A-Za-z0-9])(?:sk|pk|rk)[-_]|-----BEGIN|[0-9a-fA-F]{32}|https?:\/\/|www\.|[^\s@]+@[^\s@]+|\d{12}|secret|password|credential|api[-_]?key|bearer|private[-_]?key/i;

function collectStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out, depth + 1));
  else if (typeof v === "object" && v !== null) Object.values(v).forEach((x) => collectStrings(x, out, depth + 1));
}

const jsonNorm = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

// ── Data allowlist, derived from the generator's own output (no copy of its lists) ──
interface DataAllow {
  brands: ReadonlySet<string>;
  verbs: ReadonlySet<string>;
}
let allowCache: DataAllow | null = null;
function dataAllow(): DataAllow {
  if (allowCache) return allowCache;
  // 1000 mixed records cover every brand and verb with overwhelming margin;
  // a test pins the derived set sizes against the generator.
  const sample = generateSyntheticData({ seed: PILOT_SCENARIO_SEED, count: SYNTHETIC_MAX_COUNT, kind: "mixed" });
  const brands = new Set<string>();
  const verbs = new Set<string>();
  for (const r of sample) {
    brands.add(r.company);
    if (r.kind === "task") verbs.add(r.name.slice(r.name.indexOf(" - ") + 3));
  }
  allowCache = { brands, verbs };
  return allowCache;
}

/** Exposed for tests: derived allowlist sizes. */
export function pilotDataAllowlistSizes(): { brands: number; verbs: number } {
  const a = dataAllow();
  return { brands: a.brands.size, verbs: a.verbs.size };
}

const CUSTOMER_NAME = /^Sahte Müşteri (\d{3,4})$/;
const TASK_NAME = /^Sahte Görev (\d{3,4}) - ([^\n]{1,100})$/;
const ID_RE = /^syn-(\d{3,4})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STATUSES = new Set(["yeni", "devam", "beklemede", "tamamlandi", "iptal"]);
const RECORD_KEYS = ["amount", "company", "currency", "date", "id", "kind", "name", "status"].join();

/**
 * Validates a pilot package. Throws `PilotValidationError` (with a rule code)
 * on the first violation; a manifest-schema violation carries the ZodError as
 * `cause`. Returns the parsed package.
 */
export function validatePilotPackage(pkg: unknown): PilotPackage {
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    throw new PilotValidationError("package-shape", "package must be an object");
  }
  const keys = Object.keys(pkg).sort();
  if (keys.length !== 2 || keys[0] !== "manifest" || keys[1] !== "syntheticData") {
    throw new PilotValidationError("package-shape", "package must contain exactly manifest and syntheticData");
  }
  const { manifest: rawManifest, syntheticData } = pkg as Record<string, unknown>;

  const parsed = microAppManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    const e = new PilotValidationError("manifest-schema", parsed.error.issues.map((i) => i.message).join("; "));
    (e as { cause?: unknown }).cause = parsed.error;
    throw e;
  }
  const manifest = parsed.data;

  const strings: string[] = [];
  collectStrings(manifest, strings);
  if (strings.some((s) => SECRET_LIKE.test(s))) {
    throw new PilotValidationError("manifest-secret", "manifest contains a credential-, URL- or PII-like value");
  }

  // Pin: manifest must equal the projection of the scenario snapshot (only the
  // data ref may be null, as the export endpoint does not pass it). This also
  // forbids extra connectors/scopes (e.g. gmail.send, gmail.compose).
  if (manifest.syntheticDataRef !== null && manifest.syntheticDataRef !== PILOT_SCENARIO_ID) {
    throw new PilotValidationError("manifest-pin", "syntheticDataRef must be null or the pilot scenario id");
  }
  const expected = toMicroAppManifest(pilotScenarioSnapshot(), {
    version: PILOT_SCENARIO_VERSION,
    syntheticDataRef: manifest.syntheticDataRef,
  });
  if (!isDeepStrictEqual(jsonNorm(manifest), jsonNorm(expected))) {
    throw new PilotValidationError("manifest-pin", "manifest differs from the pilot scenario snapshot");
  }

  if (!Array.isArray(syntheticData) || syntheticData.length > SYNTHETIC_MAX_COUNT) {
    throw new PilotValidationError("data-shape", "syntheticData must be an array within the cap");
  }
  const allow = dataAllow();
  (syntheticData as unknown[]).forEach((r, index) => {
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      throw new PilotValidationError("data-shape", "record must be an object");
    }
    const rec = r as Record<string, unknown>;
    if (Object.keys(rec).sort().join() !== RECORD_KEYS) {
      throw new PilotValidationError("data-record-keys", "record has unexpected keys");
    }
    const expectedNum = String(index + 1).padStart(3, "0");
    const idm = typeof rec.id === "string" ? ID_RE.exec(rec.id) : null;
    if (!idm || idm[1] !== expectedNum) {
      throw new PilotValidationError("data-id", "record id must be sequential syn-NNN");
    }
    let nameOk = false;
    if (typeof rec.name === "string") {
      if (rec.kind === "customer") {
        const m = CUSTOMER_NAME.exec(rec.name);
        nameOk = m !== null && m[1] === expectedNum;
      } else if (rec.kind === "task") {
        const m = TASK_NAME.exec(rec.name);
        nameOk = m !== null && m[1] === expectedNum && allow.verbs.has(m[2]);
      }
    }
    if (!nameOk) throw new PilotValidationError("data-name", "record name must match the generator's fixed format");
    if (typeof rec.company !== "string" || !allow.brands.has(rec.company)) {
      throw new PilotValidationError("data-company", "company must be one of the fake brands");
    }
    if (typeof rec.status !== "string" || !STATUSES.has(rec.status)) {
      throw new PilotValidationError("data-status", "bad status");
    }
    if (
      typeof rec.amount !== "number" ||
      !Number.isFinite(rec.amount) ||
      rec.amount < 0 ||
      rec.amount >= 100000 ||
      Math.round(rec.amount * 100) / 100 !== rec.amount
    ) {
      throw new PilotValidationError("data-amount", "bad amount");
    }
    if (rec.currency !== "TRY") throw new PilotValidationError("data-currency", "bad currency");
    const dm = typeof rec.date === "string" ? DATE_RE.exec(rec.date) : null;
    const dateOk =
      dm !== null && new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3])).toISOString().slice(0, 10) === rec.date;
    if (!dateOk) throw new PilotValidationError("data-date", "bad date");
  });
  return { manifest, syntheticData: syntheticData as SyntheticRecord[] };
}
