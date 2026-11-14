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

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, "invalid identifier");
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "invalid semver");

export const microAppAgentSchema = z
  .object({
    handle: slug,
    name: z.string().min(1).max(200),
    role: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    maxTokens: z.number().int().positive(),
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
    maxDelegationDepth: z.number().int().nonnegative(),
    stepNames: z.array(z.string().min(1).max(200)).max(200),
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
    agents: z.array(microAppAgentSchema),
    pipelines: z.array(microAppPipelineSchema),
    connectorRequests: z.array(microAppConnectorRequestSchema),
    syntheticDataRef: slug.nullable(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const handles = new Set(m.agents.map((a) => a.handle));
    m.pipelines.forEach((p, i) => {
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

// Identifiers that look like credentials are dropped, never copied.
const SECRET_LOOKING = /(secret|token|password|credential|api[-_]?key|bearer)|^(sk|pk|ghp|gho|xox[a-z])[-_]/i;

const safeSlug = (v: unknown): string | null =>
  typeof v === "string" && slug.safeParse(v).success && !SECRET_LOOKING.test(v) ? v : null;

/** Tool entries: a bare string name, or `{ name }` / `{ name, connector, scopes }`. */
function readTools(tools: unknown): { names: string[]; connectors: Array<{ provider: string; scopes: string[] }> } {
  const names: string[] = [];
  const connectors: Array<{ provider: string; scopes: string[] }> = [];
  if (!Array.isArray(tools)) return { names, connectors };
  for (const t of tools) {
    const entry = typeof t === "string" ? { name: t } : isRecord(t) ? t : null;
    if (!entry) continue;
    const name = safeSlug(entry.name);
    if (name) names.push(name);
    const provider = safeSlug(entry.connector);
    if (provider) {
      const scopes = Array.isArray(entry.scopes)
        ? entry.scopes.map(safeSlug).filter((s): s is string => s !== null)
        : [];
      connectors.push({ provider, scopes });
    }
  }
  return { names, connectors };
}

function readStepNames(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s) => {
    const n = isRecord(s) ? s.name : undefined;
    return typeof n === "string" && n.length > 0 && n.length <= 200 ? [n] : [];
  });
}

/**
 * Pure, deterministic. Real/random handles are renumbered (`agent-1`, ...),
 * so equal snapshots always yield equal manifests. Throws ZodError if the
 * projection is not a valid manifest.
 */
export function toMicroAppManifest(
  snapshot: CompanyTemplateSnapshot,
  opts: ToMicroAppManifestOptions,
): MicroAppManifest {
  const handleMap = new Map<string, string>();
  snapshot.agents.forEach((a, i) => handleMap.set(a.handle, `agent-${i + 1}`));

  const merged = new Map<string, Set<string>>();
  const agents = snapshot.agents.map((a, i) => {
    const { names, connectors } = readTools(a.tools);
    for (const c of connectors) {
      const set = merged.get(c.provider) ?? new Set<string>();
      c.scopes.forEach((s) => set.add(s));
      merged.set(c.provider, set);
    }
    return {
      handle: `agent-${i + 1}`,
      name: a.name,
      role: a.role,
      model: a.model,
      maxTokens: a.maxTokens,
      toolNames: [...new Set(names)],
    };
  });

  const pipelines = snapshot.pipelines.map((p) => ({
    name: p.name,
    description: p.description,
    trigger: p.trigger,
    schedule: p.schedule,
    pipelineType: p.pipelineType,
    managerAgentHandle: p.managerAgentHandle ? handleMap.get(p.managerAgentHandle) : undefined,
    maxDelegationDepth: p.maxDelegationDepth,
    stepNames: readStepNames(p.steps),
  }));

  const connectorRequests = [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, scopes]) => ({ provider, scopes: [...scopes].sort() }));

  return microAppManifestSchema.parse({
    schemaVersion: MICRO_APP_MANIFEST_SCHEMA_VERSION,
    name: snapshot.name,
    version: opts.version,
    description: snapshot.description,
    agents,
    pipelines,
    connectorRequests,
    syntheticDataRef: opts.syntheticDataRef ?? null,
  });
}
