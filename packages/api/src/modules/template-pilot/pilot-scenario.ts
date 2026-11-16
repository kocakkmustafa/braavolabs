/**
 * BRA-P1-07-N2 — tek iş pilot senaryosu: "haftalık müşteri e-postası taslağı".
 *
 * Pure: no I/O, no clock, no randomness. Composes the existing pieces
 * (07a manifest projection + 07b synthetic data) into ONE fixed pilot package
 * and validates a package against the 07a schema plus synthetic-data rules.
 * Contains no tenant/company ids, credentials or real personal data.
 */

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

/** Template snapshot of the pilot job. Fresh object per call (no shared mutation). */
export function pilotScenarioSnapshot(): CompanyTemplateSnapshot {
  return {
    name: "Haftalık müşteri e-postası taslağı",
    description:
      "Küçük işletme pilotu: haftalık müşteri e-postası taslağını sentetik müşteri verisinden hazırlar; gönderim yoktur, yalnız taslak üretir.",
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
        schedule: "0 9 * * 1",
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

const FORBIDDEN_IN_DATA = /@|https?:\/\/|\d{12,}|[A-Z]{2}\d{2}[A-Z0-9]{10,}/;
const ID_RE = /^syn-\d{3,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(["yeni", "devam", "beklemede", "tamamlandi", "iptal"]);
const RECORD_KEYS = ["amount", "company", "currency", "date", "id", "kind", "name", "status"];

/**
 * Validates a pilot package. Throws on the first violation (a ZodError for a
 * manifest violation, an Error otherwise); returns the parsed package.
 */
export function validatePilotPackage(pkg: unknown): PilotPackage {
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    throw new Error("package must be an object");
  }
  const keys = Object.keys(pkg).sort();
  if (keys.length !== 2 || keys[0] !== "manifest" || keys[1] !== "syntheticData") {
    throw new Error("package must contain exactly manifest and syntheticData");
  }
  const { manifest: rawManifest, syntheticData } = pkg as Record<string, unknown>;
  const manifest = microAppManifestSchema.parse(rawManifest);

  if (!Array.isArray(syntheticData) || syntheticData.length > SYNTHETIC_MAX_COUNT) {
    throw new Error("syntheticData must be an array within the cap");
  }
  const seen = new Set<string>();
  for (const r of syntheticData as unknown[]) {
    if (typeof r !== "object" || r === null) throw new Error("record must be an object");
    const rec = r as Record<string, unknown>;
    if (Object.keys(rec).sort().join() !== RECORD_KEYS.join()) throw new Error("record has unexpected keys");
    if (typeof rec.id !== "string" || !ID_RE.test(rec.id) || seen.has(rec.id)) throw new Error("bad or duplicate record id");
    seen.add(rec.id);
    if (rec.kind !== "task" && rec.kind !== "customer") throw new Error("bad record kind");
    if (typeof rec.name !== "string" || !rec.name.startsWith("Sahte ")) throw new Error("record name must be a synthetic label");
    if (typeof rec.company !== "string" || !rec.company.startsWith("Sahte ")) throw new Error("record company must be a synthetic label");
    if (typeof rec.status !== "string" || !STATUSES.has(rec.status)) throw new Error("bad record status");
    if (typeof rec.amount !== "number" || !Number.isFinite(rec.amount) || rec.amount < 0 || rec.amount >= 100000) throw new Error("bad record amount");
    if (rec.currency !== "TRY") throw new Error("bad record currency");
    if (typeof rec.date !== "string" || !DATE_RE.test(rec.date)) throw new Error("bad record date");
    if (FORBIDDEN_IN_DATA.test(rec.name) || FORBIDDEN_IN_DATA.test(rec.company)) throw new Error("record looks like personal data");
  }
  return { manifest, syntheticData: syntheticData as SyntheticRecord[] };
}
