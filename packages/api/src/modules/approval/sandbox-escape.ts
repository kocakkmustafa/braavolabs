/**
 * BRA-P2-02c — SANDBOX_ESCAPE approval: sanitised metadata + exact-action hash.
 *
 * The sandbox policy (a pure function, wired elsewhere) answers
 * `escape-approval-required`; a human must then allow ONE concrete escape.
 * This module only builds the approval's metadata and its exact-action
 * binding (ADR-0002). It is NOT wired to the policy or to any executor.
 *
 * Metadata is a closed shape: { type, kind, target, targetDigest, reasonCode }.
 *   kind          `fs.write` / `net.connect` / … (^[a-z]+\.[a-z_]+$, ≤ 32)
 *   target        DISPLAY ONLY. net.* → `host:port`; other → normalised absolute
 *                 POSIX path with secret-looking segments masked to `***`.
 *   targetDigest  sha256 hex of the FULL canonical (unmasked) target. The
 *                 exact-action hash is computed over THIS, never over the masked
 *                 `target`: `/data/secret-A/f` and `/data/secret-B/f` share a
 *                 mask but not a digest, so one grant can never authorise the
 *                 other. The raw target itself is never stored.
 *   reasonCode    policy code (^[a-z0-9_-]{1,64}$, secret-shaped values rejected)
 * Raw commands and file content never enter. A target that is too long, holds
 * control/bidi/zero-width characters, or (net.*) carries userinfo / path / query
 * / fragment / backslash is REJECTED, never repaired. The executor must call
 * `buildSandboxEscapeAction` with the raw request to get the same hash.
 *
 * Known limit: targetDigest of a LOW-ENTROPY secret path segment can be
 * brute-forced offline by someone who can read the approval row (tenant members
 * who can list approvals). Acceptable here; use a keyed digest if rows ever
 * leave the tenant boundary.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { computeActionHash, type ExactAction } from "./exact-action";
import { leaksSecret } from "./details";

export const MAX_TARGET_LENGTH = 256;
export const MAX_NET_TARGET_LENGTH = 255;
export const SANDBOX_ESCAPE_TYPE = "SANDBOX_ESCAPE" as const;

const KIND_RE = /^[a-z]+\.[a-z_]+$/;
const REASON_RE = /^[a-z0-9_-]{1,64}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$|^\[[0-9a-f:]{2,45}\]$/;
// C0, DEL, C1, bidi controls/isolates, ALM, zero-width, BOM, word joiner & invisible operators.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const SECRET_SEGMENT = /token|secret|passw|credential|api[-_]?key|private[-_]?key|bearer|\.pem$|\.key$|^id_(rsa|ed25519|ecdsa)/i;

export interface SandboxEscapeRequest {
  kind: string;
  target: string;
  reasonCode: string;
}

export interface SandboxEscapeMetadata extends SandboxEscapeRequest {
  /** Marker the approval list / decide handler can key on. */
  type: typeof SANDBOX_ESCAPE_TYPE;
  /** sha256 hex of the full canonical (unmasked) target — what the exact-action hash binds to. */
  targetDigest: string;
}

export class SandboxEscapeRequestError extends Error {}

function maskSegment(seg: string): string {
  return SECRET_SEGMENT.test(seg) || leaksSecret(seg) ? "***" : seg;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Canonical full target (unmasked) + display form. */
function normalizeTarget(kind: string, raw: unknown): { canonical: string; display: string } {
  if (typeof raw !== "string" || raw.length === 0 || FORBIDDEN_CHARS.test(raw)) {
    throw new SandboxEscapeRequestError("invalid target");
  }
  if (kind.startsWith("net.")) {
    if (raw.length > MAX_NET_TARGET_LENGTH) throw new SandboxEscapeRequestError("target too long");
    if (/[?#\\@\s]/.test(raw)) throw new SandboxEscapeRequestError("invalid host:port");
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    let url: URL;
    try {
      url = new URL(hasScheme ? raw : `x://${raw}`);
    } catch {
      throw new SandboxEscapeRequestError("invalid host:port");
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new SandboxEscapeRequestError("invalid host:port");
    // URL() drops default ports (https :443); require the port to be written out.
    const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0];
    const pm = /:(\d{1,5})$/.exec(authority);
    const port = pm ? Number(pm[1]) : NaN;
    const host = url.hostname.toLowerCase();
    if (!(port >= 1 && port <= 65535) || !HOST_RE.test(host) || leaksSecret(host)) {
      throw new SandboxEscapeRequestError("invalid host:port");
    }
    const hp = `${host}:${port}`;
    return { canonical: hp, display: hp };
  }
  if (!raw.startsWith("/")) throw new SandboxEscapeRequestError("target must be an absolute path");
  const norm = posix.normalize(raw).replace(/(.)\/+$/, "$1");
  if (norm.length > MAX_TARGET_LENGTH) throw new SandboxEscapeRequestError("target too long");
  const display = norm
    .split("/")
    .map((s) => (s ? maskSegment(s) : s))
    .join("/");
  return { canonical: norm, display };
}

/** Closed-shape, sanitised metadata. Throws SandboxEscapeRequestError on any bad field (fail-closed). */
export function buildSandboxEscapeMetadata(req: SandboxEscapeRequest): SandboxEscapeMetadata {
  if (typeof req.kind !== "string" || req.kind.length > 32 || !KIND_RE.test(req.kind)) {
    throw new SandboxEscapeRequestError("invalid kind");
  }
  if (
    typeof req.reasonCode !== "string" ||
    !REASON_RE.test(req.reasonCode) ||
    SECRET_SEGMENT.test(req.reasonCode) ||
    leaksSecret(req.reasonCode)
  ) {
    throw new SandboxEscapeRequestError("invalid reasonCode");
  }
  const t = normalizeTarget(req.kind, req.target);
  return {
    type: SANDBOX_ESCAPE_TYPE,
    kind: req.kind,
    target: t.display,
    targetDigest: sha256Hex(t.canonical),
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
      // targetDigest (full target), NOT the masked display target.
      input: { kind: metadata.kind, targetDigest: metadata.targetDigest, reasonCode: metadata.reasonCode },
      amountUsd: null,
    },
  };
}

export function computeSandboxEscapeHash(ctx: { tenantId: string; runId: string }, req: SandboxEscapeRequest): string {
  return computeActionHash(buildSandboxEscapeAction(ctx, req).action);
}

/**
 * Text sent to the agent when the escape is denied. Carries the approval id so
 * de-duplication is per approval (an old consumed message for the same run+kind
 * can never suppress a later request's message). No path/target/content echoed.
 */
export function sandboxEscapeDeniedMessage(metadata: unknown, approvalId: string): string {
  const kind =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof (metadata as { kind?: unknown }).kind === "string" && KIND_RE.test((metadata as { kind: string }).kind)
      ? (metadata as { kind: string }).kind
      : "unknown";
  const id = /^[\w-]{1,64}$/.test(approvalId) ? approvalId : "unknown";
  return `Sandbox escape denied (${kind}) [approval ${id}]. Continue without leaving the sandbox.`;
}
