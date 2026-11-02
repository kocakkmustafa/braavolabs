/**
 * Skill bundles (community skill registry). A skill is SKILL.md plus a few text files; the
 * registry stores it as a canonical JSON bundle — files sorted by path, UTF-8 text only — so
 * the same content always gives the same bytes and the same SHA-256, and a client verifies
 * it without unpacking an archive.
 *
 * The source is a GitHub tag tarball (.tar.gz). It is read with a small ustar reader that
 * stops at the first limit: no archive library, no symlinks, no absolute or ".." paths.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const LIMITS = { files: 64, totalBytes: 256 * 1024, fileBytes: 64 * 1024, tarballBytes: 5 * 1024 * 1024, unpackedBytes: 20 * 1024 * 1024 } as const;
export const ALLOWED_EXT = [".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".py", ".js", ".ts", ".sh"] as const;
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,40})?$/;

export interface BundleFile { path: string; content: string }
export interface Bundle { format: 1; files: BundleFile[] }
export interface FileInfo { path: string; size: number; sha256: string }

export class BundleError extends Error {}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Regular files of a .tar.gz, path → bytes. Directories are skipped; links and devices refused. */
export function readTarGz(gz: Buffer): Map<string, Buffer> {
  if (gz.length > LIMITS.tarballBytes) throw new BundleError("source archive is larger than 5 MB");
  let tar: Buffer;
  try { tar = gunzipSync(gz, { maxOutputLength: LIMITS.unpackedBytes }); } catch { throw new BundleError("source archive is not a readable .tar.gz (or unpacks past 20 MB)"); }
  const out = new Map<string, Buffer>();
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const field = (a: number, n: number) => h.subarray(a, a + n).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new BundleError("malformed archive header");
    const type = String.fromCharCode(h[156] || 48);
    const prefix = field(345, 155);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (type === "x") { paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? null; continue; }
    if (type === "g") continue;
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = paxPath = null;
    if (type === "5") continue;
    if (type !== "0" && type !== "\0") throw new BundleError(`links and special files are not allowed (${name})`);
    out.set(name, Buffer.from(body));
  }
  return out;
}

/**
 * GitHub tarballs put everything under "<repo>-<ref>/"; strip that and keep `path/`.
 * Hidden files and folders (.git*, .github/, .braavo-publisher…) are not part of a skill.
 */
export function selectFiles(entries: Map<string, Buffer>, subdir = ""): Map<string, Buffer> {
  const clean = subdir.replace(/^\/+|\/+$/g, "");
  if (clean.split("/").some(p => p === ".." || p === ".")) throw new BundleError("path must stay inside the repository");
  const out = new Map<string, Buffer>();
  for (const [full, data] of entries) {
    const rest = full.split("/").slice(1).join("/");
    if (!rest) continue;
    if (clean && !rest.startsWith(`${clean}/`)) continue;
    const rel = clean ? rest.slice(clean.length + 1) : rest;
    if (rel.split("/").some(p => p.startsWith("."))) continue;
    out.set(rel, data);
  }
  return out;
}

/** Files → canonical bundle, enforcing every limit. */
export function buildBundle(files: Map<string, Buffer>): Bundle {
  if (files.size > LIMITS.files) throw new BundleError(`a skill has at most ${LIMITS.files} files`);
  let total = 0;
  const list: BundleFile[] = [];
  for (const [path, data] of files) {
    if (!path || path.startsWith("/") || path.split("/").some(p => p === ".." || p === "." || p.startsWith("."))) throw new BundleError(`path not allowed: ${path}`);
    if (!ALLOWED_EXT.some(e => path.toLowerCase().endsWith(e)) && path !== "LICENSE") throw new BundleError(`file type not allowed: ${path}`);
    if (data.length > LIMITS.fileBytes) throw new BundleError(`${path} is larger than 64 KB`);
    total += data.length;
    if (total > LIMITS.totalBytes) throw new BundleError("a skill is at most 256 KB");
    const text = data.toString("utf8");
    if (data.includes(0) || Buffer.from(text, "utf8").length !== data.length) throw new BundleError(`${path} is not UTF-8 text`);
    list.push({ path, content: text });
  }
  if (!list.some(f => f.path === "SKILL.md")) throw new BundleError("SKILL.md is missing");
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { format: 1, files: list };
}

/** The bytes that are hashed and stored. Key order is fixed. */
export function bundleBytes(b: Bundle): string {
  return JSON.stringify({ files: b.files.map(f => ({ path: f.path, content: f.content })), format: 1 });
}

export function bundleDigest(b: Bundle): { sha256: string; size: number; files: FileInfo[] } {
  const bytes = bundleBytes(b);
  return {
    sha256: sha256(bytes), size: Buffer.byteLength(bytes),
    files: b.files.map(f => ({ path: f.path, size: Buffer.byteLength(f.content), sha256: sha256(f.content) })),
  };
}

/** `---\nname: x\ndescription: y\n---` → fields (flat `key: value` lines only). */
export function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
