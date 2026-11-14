/**
 * Micro-app manifest schema (BRA-P1-07a).
 *
 * A manifest describes a shareable micro-app: agents, pipelines, the
 * connectors it REQUESTS (provider + scopes, never credentials), and a
 * reference to a synthetic dataset. It carries no tenant/company/user ids,
 * no secrets and no system prompts. `toMicroAppManifest` is a pure,
 * deterministic projection of an exported template snapshot.
 */

import { z } from "zod";
import type { CompanyTemplateSnapshot } from "./templates.service";

export const MICRO_APP_MANIFEST_SCHEMA_VERSION = "1" as const;

const MAX_ITEMS = 50;
const MAX_STEPS = 100;
const MAX_TOKENS_CAP = 1_000_000;
const MAX_DEPTH_CAP = 10;

const slug = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/i, "invalid identifier");
const semver = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "invalid semver");

export const microAppAgentSchema = z
  .object({
    handle: slug,
    name: z.string().min(1).max(200),
    role: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    maxTokens: z.number().int().positive().max(MAX_TOKENS_CAP),
    toolNames: z.array(slug).max(100),
  })
  .strict();

export const microAppPipelineSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    trigger: z.enum(["MANUAL", "SCHEDULED", "WEBHOOK", "EVENT"]),
    schedule: z.string().max(200).optional(),
    pipelineType: z.enum(["SEQUENTIAL", "HIERARCHICAL"]),
    managerAgentHandle: slug.optional(),
    maxDelegationDepth: z.number().int().nonnegative().max(MAX_DEPTH_CAP),
    stepNames: z.array(z.string().min(1).max(200)).max(MAX_STEPS),
  })
  .strict();

/** A connector the app asks the installer to bind. Never holds credentials. */
export const microAppConnectorRequestSchema = z
  .object({
    provider: slug,
    scopes: z.array(slug).max(50),
  })
  .strict();

export const microAppManifestSchema = z
  .object({
    schemaVersion: z.literal(MICRO_APP_MANIFEST_SCHEMA_VERSION),
    name: z.string().min(1).max(200),
    version: semver,
    description: z.string().max(2000).nullable(),
    agents: z.array(microAppAgentSchema).max(MAX_ITEMS),
    pipelines: z.array(microAppPipelineSchema).max(MAX_ITEMS),
    connectorRequests: z.array(microAppConnectorRequestSchema).max(MAX_ITEMS),
    syntheticDataRef: slug.nullable(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const handles = new Set(m.agents.map((a) => a.handle));
    m.pipelines.forEach((p, i) => {
      if (p.pipelineType === "HIERARCHICAL" && !p.managerAgentHandle) {
        ctx.addIssue({
          code: "custom",
          path: ["pipelines", i, "managerAgentHandle"],
          message: "HIERARCHICAL pipeline requires a manager",
        });
      }
      if (p.managerAgentHandle && !handles.has(p.managerAgentHandle)) {
        ctx.addIssue({
          code: "custom",
          path: ["pipelines", i, "managerAgentHandle"],
          message: "unknown agent handle",
        });
      }
    });
  });

export type MicroAppManifest = z.infer<typeof microAppManifestSchema>;

export interface ToMicroAppManifestOptions {
  version: string;
  syntheticDataRef?: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ── Credential / PII heuristics (contains-match, not anchored) ──────────
const STRONG_SOURCES = [
  "AKIA[0-9A-Z]{16}",
  "AIza[0-9A-Za-z_-]{35}",
  "eyJ[0-9A-Za-z_-]{5,}",
  "gh[pousr]_[0-9A-Za-z]+",
  "github_pat_[0-9A-Za-z_]+",
  "xox[abprs]-[0-9A-Za-z-]+",
  "xapp-[0-9A-Za-z-]+",
  "whsec_[0-9A-Za-z]+",
  "(?:rk|sk|pk)_(?:live|test)_[0-9A-Za-z]+",
  "[\\w-]{0,40}(?<![A-Za-z0-9])(?:sk|pk|rk)[-_][\\w-]{3,}",
  "-----BEGIN [A-Z ]*-----",
  "[0-9a-fA-F]{32,}",
  "(?<![a-z0-9])c[a-z0-9]{24}(?![a-z0-9])",
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
  "[A-Za-z0-9+/]{32,}={0,2}",
  "https?://\\S+",
  "[?&](?:token|key|secret|sig|signature|password)=\\S*",
];
// Free-text extras (PII-ish): e-mail, long digit runs.
const TEXT_EXTRA_SOURCES = ["[^\\s@]{1,64}@[^\\s@]{1,255}", "\\d{12,}"];
// Credential-ish words. "token" alone is deliberately absent so that
// legitimate names such as `token_counter` survive.
const SECRET_WORD = /(secret|password|credential|api[-_]?key|bearer|private[-_]?key)/i;

const STRONG_TEST = new RegExp(STRONG_SOURCES.join("|"));
const REDACT_SOURCE = [...STRONG_SOURCES, ...TEXT_EXTRA_SOURCES].join("|");
const REDACT_RE = new RegExp(REDACT_SOURCE, "g"); // use with replace() only: global regex is stateful
const REDACT_TEST = new RegExp(REDACT_SOURCE);

const looksCredential = (v: string): boolean => STRONG_TEST.test(v) || SECRET_WORD.test(v);

/**
 * Redaction (not rejection) for free text; never throws. Input is cut to
 * `max + 64` BEFORE the regexes run (snapshot JSON arrives schema-less from
 * the DB), which bounds regex work, and cut again to `max` afterwards.
 */
function redact(v: string, max: number): string {
  return v.slice(0, max + 64).replace(REDACT_RE, "[redacted]");
}

function clean(v: unknown, max: number, fallback: string): string {
  const out = redact(typeof v === "string" ? v : "", max).trim().slice(0, max);
  return out.length > 0 ? out : fallback;
}

function cleanOptional(v: unknown, max: number): string | undefined {
  const out = redact(typeof v === "string" ? v : "", max).trim().slice(0, max);
  return out.length > 0 ? out : undefined;
}

/** Identifier fields (provider / tool / scope): dropped when credential-like. */
const safeSlug = (v: unknown): string | null =>
  typeof v === "string" && v.length <= 64 && slug.safeParse(v).success && !looksCredential(v) ? v : null;

/** Tool entries: a bare string name, or `{ name }` / `{ name, connector, scopes }`. */
function readTools(tools: unknown): { names: string[]; connectors: Array<{ provider: string; scopes: string[] }> } {
  const names: string[] = [];
  const connectors: Array<{ provider: string; scopes: string[] }> = [];
  if (!Array.isArray(tools)) return { names, connectors };
  for (const t of tools.slice(0, 500)) {
    const entry = typeof t === "string" ? { name: t } : isRecord(t) ? t : null;
    if (!entry) continue;
    const name = safeSlug(entry.name);
    if (name) names.push(name);
    const provider = safeSlug(entry.connector);
    if (provider) {
      const scopes = Array.isArray(entry.scopes)
        ? entry.scopes.slice(0, 200).map(safeSlug).filter((s): s is string => s !== null)
        : [];
      connectors.push({ provider, scopes });
    }
  }
  return { names, connectors };
}

function readStepNames(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const out: string[] = [];
  for (const s of steps) {
    const n = isRecord(s) ? cleanOptional(s.name, 200) : undefined;
    if (n) out.push(n);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;

/** Build metadata is dropped; a credential-like or oversized prerelease is stripped to the core. */
function cleanVersion(v: string): string {
  const noBuild = v.slice(0, 256).split("+")[0];
  const core = noBuild.split("-")[0];
  const bad = noBuild.length > 64 || looksCredential(noBuild) || REDACT_TEST.test(noBuild);
  return bad ? core : noBuild;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const TRIGGERS = ["MANUAL", "SCHEDULED", "WEBHOOK", "EVENT"] as const;
const PIPELINE_TYPES = ["SEQUENTIAL", "HIERARCHICAL"] as const;
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

const recordList = (v: unknown, max: number): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isRecord).slice(0, max) : [];

/**
 * Pure, deterministic. Real/random handles are renumbered (`agent-1`, ...),
 * so equal snapshots always yield equal manifests. Every snapshot field is
 * read defensively (unknown shapes get safe defaults, lists are truncated,
 * free text is redacted), so a malformed or hostile SNAPSHOT never throws.
 * Only an unusable caller-supplied `version` (no valid semver core) throws
 * a ZodError.
 */
export function toMicroAppManifest(
  snapshot: CompanyTemplateSnapshot,
  opts: ToMicroAppManifestOptions,
): MicroAppManifest {
  const snap: Record<string, unknown> = isRecord(snapshot) ? snapshot : {};
  const srcAgents = recordList(snap.agents, MAX_ITEMS);
  // First occurrence wins on duplicate handles (deterministic).
  const handleMap = new Map<string, string>();
  srcAgents.forEach((a, i) => {
    if (typeof a.handle === "string" && !handleMap.has(a.handle)) handleMap.set(a.handle, `agent-${i + 1}`);
  });

  const merged = new Map<string, Set<string>>();
  const agents = srcAgents.map((a, i) => {
    const { names, connectors } = readTools(a.tools);
    for (const c of connectors) {
      const set = merged.get(c.provider) ?? new Set<string>();
      c.scopes.forEach((s) => set.add(s));
      merged.set(c.provider, set);
    }
    return {
      handle: `agent-${i + 1}`,
      name: clean(a.name, 200, "agent"),
      role: clean(a.role, 200, "agent"),
      model: clean(a.model, 200, "unspecified"),
      maxTokens: clampInt(a.maxTokens, 1, MAX_TOKENS_CAP, 1),
      toolNames: [...new Set(names)].slice(0, 100),
    };
  });

  const pipelines = recordList(snap.pipelines, MAX_ITEMS).map((p) => {
    const manager = typeof p.managerAgentHandle === "string" ? handleMap.get(p.managerAgentHandle) : undefined;
    const type = pick(p.pipelineType, PIPELINE_TYPES, "SEQUENTIAL");
    return {
      name: clean(p.name, 200, "pipeline"),
      description: cleanOptional(p.description, 2000),
      trigger: pick(p.trigger, TRIGGERS, "MANUAL"),
      schedule: cleanOptional(p.schedule, 200),
      // A HIERARCHICAL pipeline whose manager is missing/unknown/dropped
      // cannot be expressed; degrade it to SEQUENTIAL rather than drop it.
      pipelineType: type === "HIERARCHICAL" && !manager ? ("SEQUENTIAL" as const) : type,
      managerAgentHandle: manager,
      maxDelegationDepth: clampInt(p.maxDelegationDepth, 0, MAX_DEPTH_CAP, 0),
      stepNames: readStepNames(p.steps),
    };
  });

  const connectorRequests = [...merged.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .slice(0, MAX_ITEMS)
    .map(([provider, scopes]) => ({ provider, scopes: [...scopes].sort(cmp).slice(0, 50) }));

  return microAppManifestSchema.parse({
    schemaVersion: MICRO_APP_MANIFEST_SCHEMA_VERSION,
    name: clean(snap.name, 200, "micro-app"),
    version: cleanVersion(opts.version),
    description: cleanOptional(snap.description, 2000) ?? null,
    agents,
    pipelines,
    connectorRequests,
    syntheticDataRef: safeSlug(opts.syntheticDataRef) ?? null,
  });
}
