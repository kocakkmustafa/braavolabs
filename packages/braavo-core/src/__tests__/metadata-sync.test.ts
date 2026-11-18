/** BRA-P2-02d metadata-only sync contract: shape, version policy, and the content-leak guarantees. */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_KEYS,
  MAX_FILE_NAME_LEN,
  MAX_MESSAGE_CHARS,
  MAX_SNAPSHOT_ENTRIES,
  METADATA_SYNC_MIN_VERSION,
  METADATA_SYNC_PROTOCOL,
  METADATA_SYNC_VERSION,
  buildMetadataSyncMessage,
  isSafeFileName,
  parseMetadataSyncMessage as parse,
} from "../metadata-sync";
import { metadataSync } from "../index";

const H = "a".repeat(64);
const T = "2026-11-18T10:00:00.000Z";
const NAME_TOKEN = "TOP-SECRET-FILE-BODY-9f3a";
const fileMeta = (over: Record<string, unknown> = {}) => ({
  protocol: METADATA_SYNC_PROTOCOL, version: 1, type: "file-meta", sentAt: T,
  fileName: "report.md", change: "modified", contentHash: H, modifiedAt: T, ...over,
});
const snapshot = (over: Record<string, unknown> = {}) => ({
  protocol: METADATA_SYNC_PROTOCOL, version: 1, type: "worktree-snapshot", sentAt: T,
  worktreeId: "wt-1", capturedAt: T, entries: [{ fileName: "a.ts", contentHash: H, modifiedAt: T }], ...over,
});
const c = (n: number) => String.fromCodePoint(n);

describe("shape", () => {
  it("accepts a file-meta and a worktree-snapshot, from objects and from JSON text", () => {
    expect(parse(fileMeta())).toMatchObject({ ok: true, message: { type: "file-meta", fileName: "report.md" } });
    expect(parse(JSON.stringify(snapshot()))).toMatchObject({ ok: true, message: { type: "worktree-snapshot" } });
    expect(metadataSync.METADATA_SYNC_VERSION).toBe(METADATA_SYNC_VERSION);
  });
  it("a deletion carries no hash; a non-deletion must carry one", () => {
    expect(parse(fileMeta({ change: "deleted", contentHash: null })).ok).toBe(true);
    expect(parse(fileMeta({ change: "deleted" }))).toMatchObject({ ok: false, reason: "INVALID_PAYLOAD" });
    expect(parse(fileMeta({ change: "created", contentHash: null }))).toMatchObject({ ok: false, reason: "INVALID_PAYLOAD" });
  });
  it("timestamps are pinned to the exact toISOString shape (no free-length fraction channel)", () => {
    for (const modifiedAt of ["2026-11-18T10:00:00Z", "2026-11-18T10:00:00.1Z", "2026-11-18T10:00:00." + "1".repeat(5000) + "Z", "2026-11-18T10:00:00.000+02:00"]) {
      expect(parse(fileMeta({ modifiedAt })).ok, modifiedAt.slice(0, 30)).toBe(false);
    }
    expect(parse(fileMeta({ modifiedAt: new Date(0).toISOString() })).ok).toBe(true);
  });
  it("hash must be lowercase sha256 hex; time must be an ISO datetime; snapshot is bounded", () => {
    for (const contentHash of ["A".repeat(64), "a".repeat(63), "g".repeat(64), "short"]) {
      expect(parse(fileMeta({ contentHash })).ok).toBe(false);
    }
    expect(parse(fileMeta({ modifiedAt: "yesterday" })).ok).toBe(false);
    const many = Array.from({ length: MAX_SNAPSHOT_ENTRIES + 1 }, (_, i) => ({ fileName: `f${i}.ts`, contentHash: H, modifiedAt: T }));
    expect(parse(snapshot({ entries: many })).ok).toBe(false);
    expect(parse(snapshot({ entries: many.slice(0, MAX_SNAPSHOT_ENTRIES) })).ok).toBe(true);
  });
  it("builder uses the same gate (sender cannot emit what a receiver refuses)", () => {
    expect(buildMetadataSyncMessage({ type: "file-meta", fileName: "x.txt", change: "created", contentHash: H, modifiedAt: T, sentAt: T }).ok).toBe(true);
    expect(buildMetadataSyncMessage({ type: "file-meta", fileName: "dir/x.txt", change: "created", contentHash: H, modifiedAt: T, sentAt: T })).toMatchObject({ ok: false });
  });
});

describe("version policy", () => {
  it("rejects older, newer, non-integer and non-number versions; unknown type and protocol", () => {
    expect(METADATA_SYNC_MIN_VERSION).toBeLessThanOrEqual(METADATA_SYNC_VERSION);
    expect(parse(fileMeta({ version: METADATA_SYNC_MIN_VERSION - 1 }))).toEqual({ ok: false, reason: "VERSION_TOO_OLD" });
    expect(parse(fileMeta({ version: 0 }))).toEqual({ ok: false, reason: "VERSION_TOO_OLD" });
    expect(parse(fileMeta({ version: METADATA_SYNC_VERSION + 1 }))).toEqual({ ok: false, reason: "VERSION_UNSUPPORTED" });
    expect(parse(fileMeta({ version: 1.5 }))).toEqual({ ok: false, reason: "INVALID_ENVELOPE" });
    expect(parse(fileMeta({ version: "1" }))).toEqual({ ok: false, reason: "INVALID_ENVELOPE" });
    expect(parse(fileMeta({ version: -5 }))).toEqual({ ok: false, reason: "VERSION_TOO_OLD" });
    expect(parse(fileMeta({ type: "file-content" }))).toEqual({ ok: false, reason: "UNKNOWN_TYPE" });
    expect(parse(fileMeta({ protocol: "other" }))).toEqual({ ok: false, reason: "WRONG_PROTOCOL" });
  });
  it("a malformed minVersion never disables the check (fail-closed)", () => {
    for (const minVersion of [Number.NaN, -1, 1.5, Infinity, "2" as unknown as number]) {
      expect(parse(fileMeta({ version: 0 }), { minVersion }), String(minVersion)).toEqual({ ok: false, reason: "INVALID_OPTIONS" });
    }
  });
  it("a receiver may raise the floor", () => {
    expect(parse(fileMeta(), { minVersion: METADATA_SYNC_VERSION + 1 })).toEqual({ ok: false, reason: "VERSION_TOO_OLD" });
    expect(parse(fileMeta(), { minVersion: 0 }).ok).toBe(true);
  });
});

describe("file names are names, nothing else", () => {
  it("accepts ordinary names", () => {
    const slug = "2026-11-18-quarterly-planning-review-notes.md";
    const ok = ["a.ts", "my file.txt", ".env.example", "README", "report (1).md", "dosya " + c(0x15f) + c(0x11f) + ".md", slug,
      "task-management-overview.md", "disk-usage-report-2026.md", "risk-assessment-2026.md", "desk-booking-schedule.md", NAME_TOKEN];
    for (const n of ok) {
      expect(isSafeFileName(n)).toBe(true);
    }
  });
  it("refuses paths, dot segments, secrets, invisible/bidi characters and oversize names", () => {
    const bad = [
      "src/a.ts", "a\\b.ts", "/etc/passwd", "..", ".", "", " a", "a ",
      "sk-abcdefghijklmnop.txt", "Bearer abc", "-----BEGIN PRIVATE KEY-----", "x".repeat(40) + ".txt",
      "a" + c(0x202e) + "b", "a" + c(0x200b) + "b", "a" + c(0x00ad) + "b", "a" + c(0x0007) + "b", "a" + c(0x2028) + "b",
      "n".repeat(MAX_FILE_NAME_LEN + 1), "a" + c(0xd800) + "b", "a".repeat(40) + ".txt", "A1".repeat(30) + "==",
    ];
    for (const n of bad) expect(isSafeFileName(n), JSON.stringify(n)).toBe(false);
    expect(isSafeFileName("sk-" + "a".repeat(12))).toBe(false);
    expect(isSafeFileName(12)).toBe(false);
    expect(isSafeFileName(null)).toBe(false);
  });
});

describe("LEAK GUARD: no content-carrying field can cross", () => {
  const FORBIDDEN = [
    "content", "fileContent", "text", "body", "data", "payload", "blob", "base64", "diff", "patch", "snippet", "excerpt", "preview", "summary",
    "output", "stdout", "stderr", "log", "prompt", "message", "transcript", "path", "filePath", "absPath", "cwd", "directory", "url",
    "command", "args", "env", "token", "secret", "password", "apiKey", "authorization", "cookie", "screenshot", "clipboard", "keystrokes", "windowTitle",
    "FILE_CONTENT", "file-content", "File Content",
  ];
  const SENTINEL = "TOP-SECRET-FILE-BODY-9f3a";
  it("refuses every forbidden field name at the top level, with any casing/punctuation, naming the field only", () => {
    for (const k of FORBIDDEN) {
      const r = parse(fileMeta({ [k]: SENTINEL }));
      expect(r.ok, k).toBe(false);
      if (!r.ok) {
        expect(r.reason, k).toBe("FORBIDDEN_FIELD");
        expect(JSON.stringify(r)).not.toContain(SENTINEL);
      }
    }
  });
  it("refuses them nested inside snapshot entries and deep objects", () => {
    for (const k of FORBIDDEN) {
      const r = parse(snapshot({ entries: [{ fileName: "a.ts", contentHash: H, modifiedAt: T, [k]: SENTINEL }] }));
      expect(r, k).toMatchObject({ ok: false, reason: "FORBIDDEN_FIELD" });
    }
    let deep: Record<string, unknown> = { content: SENTINEL };
    for (let i = 0; i < 5; i++) deep = { wrap: deep };
    expect(parse(fileMeta({ extra: deep }))).toMatchObject({ ok: false, reason: "FORBIDDEN_FIELD" });
  });
  it("an UNKNOWN extra field is refused by the strict schema too (not only the deny-list)", () => {
    expect(parse(fileMeta({ zzz: SENTINEL }))).toMatchObject({ ok: false, reason: "INVALID_PAYLOAD" });
    expect(parse(snapshot({ entries: [{ fileName: "a.ts", contentHash: H, modifiedAt: T, zzz: 1 }] }))).toMatchObject({ ok: false, reason: "INVALID_PAYLOAD" });
  });
  it("content smuggled through allowed fields by path / secret shape / wrong format is refused", () => {
    expect(parse(fileMeta({ fileName: "src/" + SENTINEL })).ok).toBe(false);
    expect(parse(fileMeta({ fileName: "sk-" + "a".repeat(20) })).ok).toBe(false);
    expect(parse(fileMeta({ contentHash: SENTINEL })).ok).toBe(false);
    // RESIDUAL channel (documented in the module header): a plain label is a legal file name / worktree id.
    expect(parse(fileMeta({ fileName: SENTINEL })).ok).toBe(true);
    expect(parse(fileMeta({ modifiedAt: SENTINEL })).ok).toBe(false);
    expect(parse(snapshot({ worktreeId: SENTINEL + " x" })).ok).toBe(false);
  });
  it("error details never echo a value", () => {
    for (const bad of [fileMeta({ fileName: SENTINEL + "/x" }), fileMeta({ contentHash: SENTINEL }), fileMeta({ extra: SENTINEL })]) {
      const r = parse(bad);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    }
  });
  it("fuzz: whatever is accepted carries only allow-listed keys (seeded, deterministic)", () => {
    let seed = 20261118;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const keys = [...FORBIDDEN, "zzz", "extra", "meta", "id", "name", "kind", "__proto__", "constructor"];
    const vals = (): unknown => {
      const r = rnd();
      if (r < 0.2) return SENTINEL;
      if (r < 0.4) return { nested: SENTINEL };
      if (r < 0.6) return [SENTINEL];
      if (r < 0.8) return 42;
      return null;
    };
    let accepted = 0;
    for (let i = 0; i < 600; i++) {
      const base = (rnd() < 0.5 ? fileMeta() : snapshot()) as Record<string, unknown>;
      const n = Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) base[keys[Math.floor(rnd() * keys.length)]] = vals();
      if (rnd() < 0.3) base.fileName = SENTINEL + "/" + i;
      const r = parse(base);
      if (!r.ok) continue;
      accepted++;
      const walk = (node: unknown) => {
        if (Array.isArray(node)) {
          node.forEach(walk);
        } else if (node && typeof node === "object") {
          for (const [k, v] of Object.entries(node)) {
            expect(ALLOWED_KEYS.has(k), k).toBe(true);
            walk(v);
          }
        }
      };
      walk(r.message);
      expect(JSON.stringify(r.message)).not.toContain(SENTINEL);
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("never throws, bounded", () => {
  it("hostile inputs return a rejection", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const throwing = { get protocol(): string { throw new Error("boom"); } };
    const proxy = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
    for (const raw of [null, undefined, 1, true, [], "", "not json", "[1]", "null", cyclic, throwing, proxy, BigInt(1), Symbol("x"), () => 1]) {
      const r = parse(raw);
      expect(r.ok).toBe(false);
    }
  });
  it("oversize message is refused before parsing; deep nesting is refused", () => {
    expect(parse("x".repeat(MAX_MESSAGE_CHARS + 1))).toEqual({ ok: false, reason: "TOO_LARGE" });
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 40; i++) deep = { w: deep };
    expect(parse(fileMeta({ extra: deep })).ok).toBe(false);
  });
  it("a full-size valid snapshot is accepted (the size guard does not clip legitimate traffic)", () => {
    const entries = Array.from({ length: MAX_SNAPSHOT_ENTRIES }, (_, i) => ({ fileName: (String(i).padStart(3, "0") + "-" + "seg-".repeat(70)).slice(0, MAX_FILE_NAME_LEN - 3) + ".md", contentHash: H, modifiedAt: T }));
    expect(parse(snapshot({ entries })).ok).toBe(true);
    expect(JSON.stringify(snapshot({ entries })).length).toBeLessThan(MAX_MESSAGE_CHARS);
  });
  it("object input is size-checked too, and ALLOWED_KEYS is exactly the schema keys", () => {
    expect(parse(fileMeta({ extra: "x".repeat(MAX_MESSAGE_CHARS) }))).toEqual({ ok: false, reason: "TOO_LARGE" });
    expect([...ALLOWED_KEYS].sort()).toEqual(["capturedAt", "change", "contentHash", "entries", "fileName", "modifiedAt", "protocol", "sentAt", "type", "version", "worktreeId"]);
  });
  it("__proto__ as an own key does not pollute and is refused", () => {
    const r = parse('{"__proto__":{"content":"x"},"protocol":"braavo.metadata-sync","version":1}');
    expect(r).toMatchObject({ ok: false, reason: "FORBIDDEN_FIELD" });
    expect(({} as Record<string, unknown>).content).toBeUndefined();
  });
});
