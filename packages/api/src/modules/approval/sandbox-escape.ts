/**
 * BRA-P2-02c — SANDBOX_ESCAPE approval: sanitised metadata + exact-action hash.
 *
 * The sandbox policy (a pure function, wired elsewhere) answers
 * `escape-approval-required`; a human must then allow ONE concrete escape.
 * This module only builds the approval's metadata and its exact-action
 * binding (ADR-0002). It is NOT wired to the policy or to any executor.
 *
 * Metadata is a closed shape: { kind, target, reasonCode }.
 *   kind        `fs.write` / `net.connect` / … (^[a-z]+\.[a-z_]+$, ≤ 32)
 *   target      net.*  → `host:port` (lower-cased; userinfo/path/query dropped)
 *               other  → normalised absolute POSIX path (≤ MAX_TARGET_LENGTH;
 *                        longer is REJECTED, never truncated — a truncated
 *                        target would hash differently from the real action)
 *   reasonCode  policy code (^[a-z0-9_-]{1,64}$)
 * Raw commands, file content and secrets never enter: secret-looking path
 * segments are masked to `***` BEFORE hashing, so the executor must hash the
 * same sanitised form (call `buildSandboxEscapeAction` with the raw request).
 */
import { posix } from "node:path";
import { computeActionHash, type ExactAction } from "./exact-action";
import { leaksSecret } from "./details";

export const MAX_TARGET_LENGTH = 256;
export const SANDBOX_ESCAPE_TYPE = "SANDBOX_ESCAPE" as const;

const KIND_RE = /^[a-z]+\.[a-z_]+$/;
const REASON_RE = /^[a-z0-9_-]{1,64}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$|^\[[0-9a-f:]{2,45}\]$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SECRET_SEGMENT = /token|secret|passw|credential|api[-_]?key|private[-_]?key|bearer|\.pem$|\.key$|^id_(rsa|ed25519|ecdsa)/i;

export interface SandboxEscapeRequest {
  kind: string;
  target: string;
  reasonCode: string;
}

export interface SandboxEscapeMetadata extends SandboxEscapeRequest {
  /** Marker the approval list / decide handler can key on. */
  type: typeof SANDBOX_ESCAPE_TYPE;
}

export class SandboxEscapeRequestError extends Error {}

function maskSegment(seg: string): string {
  return SECRET_SEGMENT.test(seg) || leaksSecret(seg) ? "***" : seg;
}

function normalizeTarget(kind: string, raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || CONTROL_RE.test(raw)) {
    throw new SandboxEscapeRequestError("invalid target");
  }
  if (kind.startsWith("net.")) {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/?#:]+|\[[^\]]+\])(?::(\d{1,5}))?(?:[/?#].*)?$/i.exec(raw.trim());
    const host = m?.[1]?.toLowerCase();
    const port = m?.[2] ? Number(m[2]) : null;
    if (!host || !HOST_RE.test(host) || port === null || port < 1 || port > 65535) {
      throw new SandboxEscapeRequestError("invalid host:port");
    }
    if (leaksSecret(host)) throw new SandboxEscapeRequestError("invalid host:port");
    return `${host}:${port}`;
  }
  if (!raw.startsWith("/")) throw new SandboxEscapeRequestError("target must be an absolute path");
  const norm = posix.normalize(raw).replace(/(.)\/+$/, "$1");
  if (norm.length > MAX_TARGET_LENGTH) throw new SandboxEscapeRequestError("target too long");
  const masked = norm
    .split("/")
    .map((s) => (s ? maskSegment(s) : s))
    .join("/");
  return masked;
}

/** Closed-shape, sanitised metadata. Throws SandboxEscapeRequestError on any bad field (fail-closed). */
export function buildSandboxEscapeMetadata(req: SandboxEscapeRequest): SandboxEscapeMetadata {
  if (typeof req.kind !== "string" || req.kind.length > 32 || !KIND_RE.test(req.kind)) {
    throw new SandboxEscapeRequestError("invalid kind");
  }
  if (typeof req.reasonCode !== "string" || !REASON_RE.test(req.reasonCode)) {
    throw new SandboxEscapeRequestError("invalid reasonCode");
  }
  return {
    type: SANDBOX_ESCAPE_TYPE,
    kind: req.kind,
    target: normalizeTarget(req.kind, req.target),
    reasonCode: req.reasonCode,
  };
}

/** The exact action an approval binds to; same function the executor calls before running. */
export function buildSandboxEscapeAction(
  ctx: { tenantId: string; runId: string },
  req: SandboxEscapeRequest,
): { action: ExactAction; metadata: SandboxEscapeMetadata } {
  const metadata = buildSandboxEscapeMetadata(req);
  return {
    metadata,
    action: {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      type: SANDBOX_ESCAPE_TYPE,
      toolName: metadata.kind,
      input: { kind: metadata.kind, target: metadata.target, reasonCode: metadata.reasonCode },
      amountUsd: null,
    },
  };
}

export function computeSandboxEscapeHash(ctx: { tenantId: string; runId: string }, req: SandboxEscapeRequest): string {
  return computeActionHash(buildSandboxEscapeAction(ctx, req).action);
}

/** Text sent to the agent when the escape is denied (no target/content echoed beyond kind). */
export function sandboxEscapeDeniedMessage(metadata: unknown): string {
  const kind =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof (metadata as { kind?: unknown }).kind === "string" && KIND_RE.test((metadata as { kind: string }).kind)
      ? (metadata as { kind: string }).kind
      : "unknown";
  return `Sandbox escape denied (${kind}). Continue without leaving the sandbox.`;
}
