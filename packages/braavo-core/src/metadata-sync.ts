/**
 * Local <-> cloud METADATA-ONLY sync contract (BRA-P2-02d, ADR-0008 "Gozetim yok ile uyum").
 *
 * What may cross the wire: a message type + protocol version, a bare FILE NAME (no directory), a SHA-256 of the
 * content (computed locally, the content itself never leaves), and timestamps. Nothing else:
 * no content, diff, snippet, path, command, output, prompt, screenshot, clipboard or keystroke field exists
 * in any message, and the parser refuses such a field by NAME before it looks at the payload (fail-closed).
 *
 * Pure: no I/O, no clock, no crypto (callers pass the hash they computed), never throws. Not wired to any
 * route, flag, daemon or UI. Kept OUT of `relay-protocol.ts` on purpose: that file is a byte-identical copy of
 * the API's relay protocol (guarded by parity.test.ts), so a new family lives in its own module.
 *
 * RESIDUAL CHANNELS (cannot be closed by a contract; bounded, and the receiver must treat them as untrusted
 * labels, never as instructions): `fileName` (<=255 chars, up to 200 per snapshot), `worktreeId` (<=64 chars) and
 * `contentHash` (256 bits; a hash of a small low-entropy file can be dictionary-guessed). Timestamps are pinned to
 * the exact `Date#toISOString` shape so they carry no free digits. Forward ONLY the validated `message`, never the
 * raw text (JSON duplicate keys: the last one wins here, another parser may pick the first).
 *
 * Version policy: `version` is an integer. Anything below `METADATA_SYNC_MIN_VERSION` is rejected as too old,
 * anything above `METADATA_SYNC_VERSION` is rejected as unsupported (an unknown newer shape may carry fields
 * this reader cannot judge), unknown `type` is rejected. Errors never echo input values.
 */
import { z } from "zod";

export const METADATA_SYNC_PROTOCOL = "braavo.metadata-sync" as const;
/** Current wire version. */
export const METADATA_SYNC_VERSION = 1;
/** Oldest version this reader still accepts (older senders are rejected, not downgraded). */
export const METADATA_SYNC_MIN_VERSION = 1;

export const MAX_FILE_NAME_LEN = 255;
export const MAX_SNAPSHOT_ENTRIES = 200;
/** Serialized size guard (UTF-16 units) applied before validation; a full 200-entry snapshot is ~80k. */
export const MAX_MESSAGE_CHARS = 131_072;
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_KEYS = 2_000;

export const METADATA_SYNC_TYPES = ["file-meta", "worktree-snapshot"] as const;
export type MetadataSyncType = (typeof METADATA_SYNC_TYPES)[number];
export const FILE_CHANGES = ["created", "modified", "deleted"] as const;

// ---- field validators ------------------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;
const STRUCTURED_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Control, format/invisible/bidi, separators: a name must look like what it is. */
const NAME_FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;
/**
 * Provider-key prefix (at a word start, so `task-management.md` is fine), bearer token, PEM block, or one long
 * separator-free run (hex/base64): secret-shaped, never a file name. Hyphenated slugs of any length are allowed.
 */
const SECRET_SHAPED = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{10,}|Bearer\s|-----BEGIN|[A-Za-z0-9+/=]{40,}/i;

/** Bare file name: no directory part, no dot-segments, no secret shape, no invisible characters. */
export function isSafeFileName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= 1 &&
    v.length <= MAX_FILE_NAME_LEN &&
    v === v.trim() &&
    v !== "." &&
    v !== ".." &&
    !v.includes("/") &&
    !v.includes("\\") &&
    !NAME_FORBIDDEN_CHARS.test(v) &&
    !SECRET_SHAPED.test(v)
  );
}

const fileName = z.string().refine(isSafeFileName, { message: "invalid file name" });
const contentHash = z.string().regex(SHA256_HEX);
/** Exactly `YYYY-MM-DDTHH:mm:ss.sssZ` (what `Date#toISOString` returns): no free-length fraction. */
const timestamp = z.iso.datetime({ precision: 3 });
const worktreeId = z.string().regex(STRUCTURED_ID);

const envelope = {
  protocol: z.literal(METADATA_SYNC_PROTOCOL),
  version: z.number().int().min(METADATA_SYNC_MIN_VERSION).max(METADATA_SYNC_VERSION),
  sentAt: timestamp,
};

const FileMetaSchema = z
  .strictObject({
    ...envelope,
    type: z.literal("file-meta"),
    fileName,
    change: z.enum(FILE_CHANGES),
    /** SHA-256 of the file content as computed locally; null only for a deletion. */
    contentHash: contentHash.nullable(),
    modifiedAt: timestamp,
  })
  .refine((m) => (m.change === "deleted") === (m.contentHash === null), { message: "contentHash/change mismatch" });

const SnapshotEntrySchema = z.strictObject({ fileName, contentHash, modifiedAt: timestamp });

const WorktreeSnapshotSchema = z.strictObject({
  ...envelope,
  type: z.literal("worktree-snapshot"),
  worktreeId,
  capturedAt: timestamp,
  entries: z.array(SnapshotEntrySchema).max(MAX_SNAPSHOT_ENTRIES),
});

const MetadataSyncMessageSchema = z.discriminatedUnion("type", [FileMetaSchema, WorktreeSnapshotSchema]);
export type FileMetaMessage = z.infer<typeof FileMetaSchema>;
export type WorktreeSnapshotMessage = z.infer<typeof WorktreeSnapshotSchema>;
export type MetadataSyncMessage = z.infer<typeof MetadataSyncMessageSchema>;

/** Every key a valid message (or nested entry) may carry, derived from the schemas (single source of truth). */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(FileMetaSchema.shape),
  ...Object.keys(WorktreeSnapshotSchema.shape),
  ...Object.keys(SnapshotEntrySchema.shape),
]);

// ---- content-carrying field names (refused by name, before schema parsing) -------------------------------

/** Normalized (lowercase, letters+digits only) names that mean "content / location / secret / activity". */
const FORBIDDEN_KEY_NAMES: ReadonlySet<string> = new Set([
  "content", "contents", "filecontent", "filecontents", "text", "body", "data", "payload", "blob", "raw", "bytes", "base64", "b64",
  "diff", "patch", "snippet", "excerpt", "preview", "summary", "lines", "line",
  "output", "stdout", "stderr", "log", "logs", "prompt", "message", "transcript", "history",
  "path", "filepath", "fullpath", "abspath", "relpath", "dir", "directory", "folder", "cwd", "root", "workspace", "url", "uri",
  "command", "cmd", "args", "argv", "env", "environment",
  "token", "secret", "password", "passwd", "apikey", "authorization", "auth", "cookie", "credential", "credentials", "key",
  "screenshot", "image", "screen", "clipboard", "keystrokes", "keys", "title", "windowtitle", "app", "activity",
]);

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** First forbidden key name found anywhere in plain JSON data (bounded depth and key count), else null. */
function findForbiddenKey(v: unknown): string | null {
  let seen = 0;
  const walk = (node: unknown, depth: number): string | null => {
    if (node === null || typeof node !== "object") return null;
    if (depth > MAX_SCAN_DEPTH) return "(too deep)";
    if (Array.isArray(node)) {
      for (const item of node) {
        const r = walk(item, depth + 1);
        if (r) return r;
      }
      return null;
    }
    for (const k of Object.keys(node as Record<string, unknown>)) {
      if (++seen > MAX_SCAN_KEYS) return "(too many keys)";
      if (FORBIDDEN_KEY_NAMES.has(normalizeKey(k))) return normalizeKey(k);
      const r = walk((node as Record<string, unknown>)[k], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(v, 0);
}

// ---- parse ------------------------------------------------------------------------------------------------

export type MetadataSyncRejection =
  | "TOO_LARGE"
  | "INVALID_ENVELOPE"
  | "FORBIDDEN_FIELD"
  | "WRONG_PROTOCOL"
  | "VERSION_TOO_OLD"
  | "VERSION_UNSUPPORTED"
  | "UNKNOWN_TYPE"
  | "INVALID_PAYLOAD"
  | "INVALID_OPTIONS";

export type MetadataSyncResult =
  | { ok: true; message: MetadataSyncMessage }
  | { ok: false; reason: MetadataSyncRejection; /** Field NAMES only (forbidden key or schema path); never a value. */ detail?: string };

export interface ParseOptions {
  /** Raise the floor above the module default (e.g. a receiver that dropped an old version). */
  minVersion?: number;
}

const reject = (reason: MetadataSyncRejection, detail?: string): MetadataSyncResult =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

/**
 * Validate one inbound (or about-to-be-sent) message. Accepts a JSON string or an already-decoded value.
 * The value is first normalised through JSON (one read of every getter, no prototypes, cycles refused), then
 * checked in this order: option sanity, size, forbidden field names, protocol, version, type, strict payload schema.
 */
export function parseMetadataSyncMessage(raw: unknown, opts: ParseOptions = {}): MetadataSyncResult {
  try {
    if (opts.minVersion !== undefined && !(Number.isSafeInteger(opts.minVersion) && opts.minVersion >= 0)) {
      return reject("INVALID_OPTIONS"); // a malformed floor must never silently disable the version check
    }
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else {
      const encoded = JSON.stringify(raw);
      if (typeof encoded !== "string") return reject("INVALID_ENVELOPE");
      text = encoded;
    }
    if (text.length > MAX_MESSAGE_CHARS) return reject("TOO_LARGE");
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return reject("INVALID_ENVELOPE");

    const forbidden = findForbiddenKey(data);
    if (forbidden) return reject("FORBIDDEN_FIELD", forbidden);

    const env = data as Record<string, unknown>;
    if (env.protocol !== METADATA_SYNC_PROTOCOL) return reject("WRONG_PROTOCOL");
    const v = env.version;
    if (typeof v !== "number" || !Number.isInteger(v)) return reject("INVALID_ENVELOPE");
    const floor = Math.max(METADATA_SYNC_MIN_VERSION, opts.minVersion ?? METADATA_SYNC_MIN_VERSION);
    if (v < floor) return reject("VERSION_TOO_OLD");
    if (v > METADATA_SYNC_VERSION) return reject("VERSION_UNSUPPORTED");
    if (typeof env.type !== "string" || !(METADATA_SYNC_TYPES as readonly string[]).includes(env.type)) {
      return reject("UNKNOWN_TYPE");
    }

    const parsed = MetadataSyncMessageSchema.safeParse(data);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return reject("INVALID_PAYLOAD", first ? first.path.filter((p) => typeof p === "string" || typeof p === "number").join(".") : undefined);
    }
    return { ok: true, message: parsed.data };
  } catch {
    return reject("INVALID_ENVELOPE");
  }
}

/** Build + validate an outbound message; the same gate as inbound, so a sender cannot emit what a receiver refuses. */
export function buildMetadataSyncMessage(
  body: { type: "file-meta"; fileName: string; change: (typeof FILE_CHANGES)[number]; contentHash: string | null; modifiedAt: string; sentAt: string }
    | { type: "worktree-snapshot"; worktreeId: string; capturedAt: string; entries: Array<{ fileName: string; contentHash: string; modifiedAt: string }>; sentAt: string },
): MetadataSyncResult {
  return parseMetadataSyncMessage({ protocol: METADATA_SYNC_PROTOCOL, version: METADATA_SYNC_VERSION, ...body });
}
