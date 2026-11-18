/**
 * BRA-P2-02e — dry-run worktree PREVIEW, shaped like the metadata-only `worktree-snapshot` message of
 * `packages/braavo-core/src/metadata-sync.ts` (BRA-P2-02d, ADR-0008). PURE: no I/O, no persistence, no clock
 * (callers pass `now`). The cloud never writes the plan anywhere (persistence is deferred, see ADR-0008).
 *
 * What leaves: bare file names (no directory), SHA-256 of the patch content computed here, timestamps, counts.
 * What never leaves: content, any path, the absolute work dir, the root, planner messages (they can echo input).
 *
 * The API does not import @braavo/core yet, so the few wire constants and the file-name rule are mirrored
 * here in a deliberately STRICTER form (ASCII subset). `__tests__/worktree-plan-route.test.ts` parses every
 * snapshot with the real core parser, so a drift of the contract fails a test instead of production.
 */
import { createHash } from "node:crypto";
import type { PatchInput, PatchOp, WorktreePlan } from "./worktree-planner";

export const METADATA_SYNC_PROTOCOL = "braavo.metadata-sync";
export const METADATA_SYNC_VERSION = 1;
/** Mirrors core MAX_SNAPSHOT_ENTRIES; entries beyond it are counted in `summary.omittedEntries`. */
export const SNAPSHOT_MAX_ENTRIES = 200;

/** Conservative ASCII subset of core's `isSafeFileName`; anything else is omitted and counted, never emitted. */
const SAFE_NAME = /^[A-Za-z0-9._()+@=, -]{1,120}$/;
const SECRET_SHAPED = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{10,}|Bearer\s|-----BEGIN|[A-Za-z0-9+/=]{40,}/i;

export function isPreviewSafeName(n: string): boolean {
  return SAFE_NAME.test(n) && n === n.trim() && n !== "." && n !== ".." && !SECRET_SHAPED.test(n);
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export interface WorktreePreview {
  dryRun: true;
  ok: true;
  snapshot: {
    protocol: typeof METADATA_SYNC_PROTOCOL;
    version: number;
    type: "worktree-snapshot";
    sentAt: string;
    worktreeId: string;
    capturedAt: string;
    entries: Array<{ fileName: string; contentHash: string; modifiedAt: string }>;
  };
  summary: {
    files: number;
    bytes: number;
    byOp: Record<PatchOp, number>;
    sensitive: number;
    entries: number;
    /** Non-delete files that are not in `entries` (unsafe/non-ASCII name, no content, or over the entry cap). */
    omittedEntries: number;
  };
}

export function buildWorktreePreview(
  plan: Extract<WorktreePlan, { ok: true }>,
  patches: readonly PatchInput[],
  ctx: { tenantId: string; agentId: string; now: Date },
): WorktreePreview {
  const stamp = ctx.now.toISOString();
  const contentByPath = new Map<string, string>();
  for (const p of patches) if (typeof p.content === "string") contentByPath.set(p.path, p.content);

  const byOp: Record<PatchOp, number> = { create: 0, modify: 0, delete: 0 };
  let bytes = 0;
  let sensitive = 0;
  const candidates: Array<{ path: string; fileName: string; contentHash: string }> = [];
  let nonDelete = 0;
  for (const f of [...plan.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    byOp[f.op]++;
    bytes += f.bytes;
    if (f.sensitive) sensitive++;
    if (f.op === "delete") continue;
    nonDelete++;
    const content = contentByPath.get(f.path);
    const fileName = baseName(f.path);
    if (content === undefined || !isPreviewSafeName(fileName)) continue;
    candidates.push({ path: f.path, fileName, contentHash: sha256(content) });
  }
  const entries = candidates
    .slice(0, SNAPSHOT_MAX_ENTRIES)
    .map((c) => ({ fileName: c.fileName, contentHash: c.contentHash, modifiedAt: stamp }));

  return {
    dryRun: true,
    ok: true,
    snapshot: {
      protocol: METADATA_SYNC_PROTOCOL,
      version: METADATA_SYNC_VERSION,
      type: "worktree-snapshot",
      sentAt: stamp,
      worktreeId: "wp-" + sha256(`${ctx.tenantId}:${ctx.agentId}:${plan.workDir}`).slice(0, 24),
      capturedAt: stamp,
      entries,
    },
    summary: {
      files: plan.files.length,
      bytes,
      byOp,
      sensitive,
      entries: entries.length,
      omittedEntries: nonDelete - entries.length,
    },
  };
}
