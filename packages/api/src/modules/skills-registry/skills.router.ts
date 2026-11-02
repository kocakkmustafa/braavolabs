/**
 * Community skill registry (2026-11-02). Design: TASARIM-skill-pazari.tr.md.
 *
 * Public:
 *   GET  /skills?q=&trust=                        approved packages (latest approved version)
 *   GET  /skills/revocations                      signed revocation list
 *   GET  /skills/:name                            detail: SKILL.md, files, versions, trust, reports
 *   GET  /skills/:name/versions/:version          bundle + signed manifest (APPROVED only)
 * Signed in:
 *   POST /skills/publisher                        { handle } — become a publisher
 *   POST /skills/publish                          { name, version, repo, ref, path? }
 *   POST /skills/:name/report                     { version?, severity, reason, details? }
 * Admin (MARKETPLACE_ADMIN_EMAILS, same moderators as connectors):
 *   GET  /skills/admin/queue
 *   POST /skills/:name/versions/:version/approve | reject | revoke
 *   POST /skills/publisher/:handle/verify | suspend
 *
 * A version is immutable once published. The source comes only from codeload.github.com
 * (fixed host, size-capped). The publisher proves control of the repository with a
 * `.braavo-publisher` file holding their handle at the tagged ref.
 */
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { systemScope } from "../../middleware/system-scope";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { logger } from "../../lib/logger";
import { BundleError, buildBundle, bundleBytes, bundleDigest, frontmatter, LIMITS, NAME_RE, readTarGz, SEMVER_RE, selectFiles, type FileInfo } from "./bundle";
import { scanBundle, worst, type Finding } from "./scan";
import { signCanonical } from "./signing";

export const skillsRegistryRouter = Router();

const MAX_VERSIONS_PER_DAY = 20;
const MAX_REPORTS_PER_DAY = 10;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type Trust = "OFFICIAL" | "VERIFIED" | "COMMUNITY";
const trustOf = (p: { official: boolean; verified: boolean }): Trust => (p.official ? "OFFICIAL" : p.verified ? "VERIFIED" : "COMMUNITY");

/** The manifest the registry signs for an approved version. */
export function manifestFor(v: { name: string; version: string; sha256: string; publisher: string; trust: Trust; approvedAt: string; files: FileInfo[] }) {
  return signCanonical({ name: v.name, version: v.version, sha256: v.sha256, publisher: v.publisher, trust: v.trust, approvedAt: v.approvedAt, files: v.files });
}

function isAdminEmail(email: string | null | undefined): boolean {
  const admins = (process.env.MARKETPLACE_ADMIN_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  return !!email && admins.includes(email.toLowerCase());
}
async function assertAdmin(userId: string): Promise<void> {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!isAdminEmail(me?.email)) throw new AppError(403, "Skill moderation is restricted to platform admins");
}
async function audit(req: { auth?: { tenantId: string; userId: string } }, action: string, resourceId: string, details: Record<string, unknown>) {
  try {
    await prisma.activityLog.create({ data: { tenantId: req.auth!.tenantId, actor: req.auth!.userId, action, resource: "skill", resourceId, details: details as object } });
  } catch (err) { logger.warn({ err }, "skill audit log failed"); }
}

/** A GitHub tag's tarball, at most 5 MB, from the one host the registry reads. */
export async function fetchTagTarball(repo: string, ref: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchImpl(`https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(ref)}`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) throw new AppError(404, `tag ${ref} not found in ${repo} (public repositories only)`);
  if (!res.ok || !res.body) throw new AppError(502, `GitHub answered ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > LIMITS.tarballBytes) throw new AppError(413, "source archive is larger than 5 MB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > LIMITS.tarballBytes) throw new AppError(413, "source archive is larger than 5 MB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

let fetchSource = fetchTagTarball;
/** Tests swap the GitHub fetch. */
export function setSourceFetcher(f: typeof fetchTagTarball): void { fetchSource = f; }

// ── public ──────────────────────────────────────────────────────────────────

skillsRegistryRouter.get("/", systemScope("route:skills-public"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const trust = typeof req.query.trust === "string" && ["OFFICIAL", "VERIFIED", "COMMUNITY"].includes(req.query.trust) ? req.query.trust as Trust : undefined;
    const packages = await prisma.skillPackage.findMany({
      where: {
        versions: { some: { state: "APPROVED" } },
        ...(trust ? { trust } : {}),
        ...(q ? { OR: [{ name: { contains: q.toLowerCase() } }, { description: { contains: q, mode: "insensitive" as const } }] } : {}),
      },
      include: { publisher: { select: { handle: true, verified: true } }, versions: { where: { state: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 1, select: { version: true, createdAt: true } } },
      orderBy: { downloads: "desc" },
      take: 50,
    });
    res.json({ skills: packages.map(p => ({ name: p.name, description: p.description, trust: p.trust, downloads: p.downloads, publisher: p.publisher.handle, latest: p.versions[0]?.version ?? null })) });
  } catch (err) { next(err); }
});

let revocationCache: { at: number; body: unknown } | null = null;
skillsRegistryRouter.get("/revocations", systemScope("route:skills-public"), async (_req, res, next) => {
  try {
    if (!revocationCache || Date.now() - revocationCache.at > 5 * 60_000) {
      const rows = await prisma.skillRevocation.findMany({ orderBy: { createdAt: "asc" }, take: 5000 });
      const entries = rows.map(r => ({ name: r.name, version: r.version, sha256: r.sha256, reason: r.reason, revokedAt: r.createdAt.toISOString() }));
      const issuedAt = new Date().toISOString();
      const { text, signature } = signCanonical({ issuedAt, entries });
      revocationCache = { at: Date.now(), body: { issuedAt, entries, signedList: text, signature } };
    }
    res.json(revocationCache.body);
  } catch (err) { next(err); }
});
export const _resetRevocationCache = () => { revocationCache = null; };

skillsRegistryRouter.get("/:name", systemScope("route:skills-public"), async (req, res, next) => {
  try {
    const pkg = await prisma.skillPackage.findUnique({
      where: { name: req.params.name },
      include: { publisher: { select: { handle: true, verified: true, official: true } }, versions: { where: { state: "APPROVED" }, orderBy: { createdAt: "desc" }, select: { id: true, version: true, sha256: true, size: true, files: true, skillMd: true, createdAt: true } } },
    });
    if (!pkg || !pkg.versions.length) throw new AppError(404, "skill not found");
    const openReports = await prisma.skillReport.count({ where: { status: "OPEN", version: { packageId: pkg.id } } });
    const latest = pkg.versions[0];
    res.json({
      name: pkg.name, description: pkg.description, trust: pkg.trust, downloads: pkg.downloads, publisher: pkg.publisher, openReports,
      latest: { version: latest.version, sha256: latest.sha256, size: latest.size, files: latest.files, skillMd: latest.skillMd },
      versions: pkg.versions.map(v => ({ version: v.version, sha256: v.sha256, publishedAt: v.createdAt.toISOString() })),
    });
  } catch (err) { next(err); }
});

skillsRegistryRouter.get("/:name/versions/:version", systemScope("route:skills-public"), async (req, res, next) => {
  try {
    const v = await prisma.skillVersion.findFirst({ where: { version: req.params.version, state: "APPROVED", package: { name: req.params.name } }, select: { id: true, packageId: true, bundle: true, sha256: true, signedManifest: true, signature: true } });
    if (!v || !v.signature) throw new AppError(404, "version not found or not approved");
    await prisma.skillPackage.update({ where: { id: v.packageId }, data: { downloads: { increment: 1 } } }).catch(() => undefined);
    res.json({ name: req.params.name, version: req.params.version, sha256: v.sha256, bundle: v.bundle, signedManifest: v.signedManifest, signature: v.signature });
  } catch (err) { next(err); }
});

// ── signed in ───────────────────────────────────────────────────────────────

const authed = Router();
authed.use(authMiddleware);

authed.post("/publisher", async (req, res, next) => {
  try {
    const { handle } = z.object({ handle: z.string().regex(NAME_RE) }).parse(req.body);
    const existing = await prisma.skillPublisher.findUnique({ where: { userId: req.auth!.userId } });
    if (existing) return void res.json({ publisher: existing });
    if (await prisma.skillPublisher.findUnique({ where: { handle } })) throw new AppError(409, "handle is taken");
    res.status(201).json({ publisher: await prisma.skillPublisher.create({ data: { userId: req.auth!.userId, handle } }) });
  } catch (err) { next(err); }
});

const publishSchema = z.object({
  name: z.string().regex(NAME_RE),
  version: z.string().regex(SEMVER_RE),
  repo: z.string().regex(REPO_RE),
  ref: z.string().regex(REF_RE),
  path: z.string().max(200).regex(/^[A-Za-z0-9._/-]*$/).optional(),
});

authed.post("/publish", async (req, res, next) => {
  try {
    const body = publishSchema.parse(req.body);
    const publisher = await prisma.skillPublisher.findUnique({ where: { userId: req.auth!.userId } });
    if (!publisher) throw new AppError(403, "register a publisher handle first (POST /skills/publisher)");
    if (publisher.status !== "ACTIVE") throw new AppError(403, "this publisher is suspended");
    const pkg = await prisma.skillPackage.findUnique({ where: { name: body.name } });
    if (pkg && pkg.publisherId !== publisher.id) throw new AppError(403, "this skill name belongs to another publisher");
    if (pkg && await prisma.skillVersion.findUnique({ where: { packageId_version: { packageId: pkg.id, version: body.version } } })) throw new AppError(409, "this version exists; versions cannot be replaced");
    const today = await prisma.skillVersion.count({ where: { package: { publisherId: publisher.id }, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
    if (today >= MAX_VERSIONS_PER_DAY) throw new AppError(429, `at most ${MAX_VERSIONS_PER_DAY} versions a day`);

    let entries: Map<string, Buffer>;
    let bundle;
    try {
      entries = readTarGz(await fetchSource(body.repo, body.ref));
      const proof = [...entries].find(([p]) => p.split("/").length === 2 && p.endsWith("/.braavo-publisher"))?.[1]?.toString("utf8").trim();
      if (proof !== publisher.handle) throw new AppError(403, `add a .braavo-publisher file containing "${publisher.handle}" at the root of ${body.repo} for ${body.ref}`);
      bundle = buildBundle(selectFiles(entries, body.path));
    } catch (err) {
      if (err instanceof BundleError) throw new AppError(422, err.message);
      throw err;
    }
    const digest = bundleDigest(bundle);
    const findings: Finding[] = scanBundle(bundle, body.name);
    const level = worst(findings);
    const releasedBefore = await prisma.skillVersion.count({ where: { state: "APPROVED", package: { publisherId: publisher.id } } });
    const trusted = publisher.official || publisher.verified;
    const state = level === "block" ? "REJECTED" : trusted && level === null && releasedBefore > 0 ? "APPROVED" : "NEEDS_REVIEW";
    const skillMd = bundle.files.find(f => f.path === "SKILL.md")!.content;
    const description = (frontmatter(skillMd).description ?? "").slice(0, 500);
    const approvedAt = new Date().toISOString();
    const signed = state === "APPROVED" ? manifestFor({ name: body.name, version: body.version, sha256: digest.sha256, publisher: publisher.handle, trust: trustOf(publisher), approvedAt, files: digest.files }) : null;

    const version = await prisma.$transaction(async tx => {
      const p = pkg ?? await tx.skillPackage.create({ data: { name: body.name, publisherId: publisher.id, description } });
      if (state === "APPROVED") await tx.skillPackage.update({ where: { id: p.id }, data: { trust: trustOf(publisher), description } });
      return tx.skillVersion.create({
        data: {
          packageId: p.id, version: body.version, sourceRepo: body.repo, sourceRef: body.ref,
          bundle: bundleBytes(bundle), sha256: digest.sha256, size: digest.size, skillMd, files: digest.files as object[], findings: findings as object[],
          state, ...(signed ? { signedManifest: signed.text, signature: signed.signature, reviewedBy: "auto", reviewedAt: new Date(approvedAt) } : {}),
        },
      });
    });
    await audit(req, "skill.publish", version.id, { name: body.name, version: body.version, state, findings: findings.filter(f => f.level !== "info").length });
    res.status(201).json({ name: body.name, version: body.version, state, sha256: digest.sha256, findings });
  } catch (err) { next(err); }
});

authed.post("/:name/report", async (req, res, next) => {
  try {
    const body = z.object({ version: z.string().regex(SEMVER_RE).optional(), severity: z.enum(["LOW", "HIGH"]).default("LOW"), reason: z.string().min(3).max(200), details: z.string().max(4000).default("") }).parse(req.body);
    const since = new Date(Date.now() - 86_400_000);
    if (await prisma.skillReport.count({ where: { reporterUserId: req.auth!.userId, createdAt: { gte: since } } }) >= MAX_REPORTS_PER_DAY) throw new AppError(429, `at most ${MAX_REPORTS_PER_DAY} reports a day`);
    const v = await prisma.skillVersion.findFirst({
      where: { package: { name: req.params.name }, state: "APPROVED", ...(body.version ? { version: body.version } : {}) },
      orderBy: { createdAt: "desc" }, include: { package: { include: { publisher: true } } },
    });
    if (!v) throw new AppError(404, "skill version not found");
    const report = await prisma.skillReport.create({ data: { versionId: v.id, reporterUserId: req.auth!.userId, severity: body.severity, reason: body.reason, details: body.details } });
    // A serious report pulls a community skill from the catalog until a person looks at it.
    // Installed copies keep working: only a revocation disables them.
    const pulled = body.severity === "HIGH" && !v.package.publisher.verified && !v.package.publisher.official;
    if (pulled) await prisma.skillVersion.update({ where: { id: v.id }, data: { state: "NEEDS_REVIEW" } });
    await audit(req, "skill.report", v.id, { name: req.params.name, version: v.version, severity: body.severity, pulled });
    res.status(201).json({ id: report.id, pulled });
  } catch (err) { next(err); }
});

// ── admin ───────────────────────────────────────────────────────────────────

authed.get("/admin/queue", async (req, res, next) => {
  try {
    await assertAdmin(req.auth!.userId);
    const [pending, reports] = await Promise.all([
      prisma.skillVersion.findMany({ where: { state: "NEEDS_REVIEW" }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true, version: true, sha256: true, sourceRepo: true, sourceRef: true, findings: true, skillMd: true, files: true, createdAt: true, package: { select: { name: true, publisher: { select: { handle: true, verified: true } } } } } }),
      prisma.skillReport.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" }, take: 100, include: { version: { select: { version: true, package: { select: { name: true } } } } } }),
    ]);
    res.json({ pending, reports });
  } catch (err) { next(err); }
});

async function versionFor(name: string, version: string) {
  const v = await prisma.skillVersion.findFirst({ where: { version, package: { name } }, include: { package: { include: { publisher: true } } } });
  if (!v) throw new AppError(404, "skill version not found");
  return v;
}

authed.post("/:name/versions/:version/approve", async (req, res, next) => {
  try {
    await assertAdmin(req.auth!.userId);
    const v = await versionFor(req.params.name, req.params.version);
    if (v.state !== "NEEDS_REVIEW") throw new AppError(409, `version is ${v.state}`);
    const publisher = v.package.publisher;
    const approvedAt = new Date().toISOString();
    const signed = manifestFor({ name: v.package.name, version: v.version, sha256: v.sha256, publisher: publisher.handle, trust: trustOf(publisher), approvedAt, files: v.files as unknown as FileInfo[] });
    await prisma.$transaction([
      prisma.skillVersion.update({ where: { id: v.id }, data: { state: "APPROVED", signedManifest: signed.text, signature: signed.signature, reviewedBy: req.auth!.userId, reviewedAt: new Date(approvedAt) } }),
      prisma.skillPackage.update({ where: { id: v.packageId }, data: { trust: trustOf(publisher) } }),
      prisma.skillReport.updateMany({ where: { versionId: v.id, status: "OPEN" }, data: { status: "DISMISSED" } }),
    ]);
    await audit(req, "skill.approve", v.id, { name: v.package.name, version: v.version });
    res.json({ state: "APPROVED" });
  } catch (err) { next(err); }
});

authed.post("/:name/versions/:version/reject", async (req, res, next) => {
  try {
    await assertAdmin(req.auth!.userId);
    const { reason, strike } = z.object({ reason: z.string().min(3).max(300), strike: z.boolean().default(false) }).parse(req.body);
    const v = await versionFor(req.params.name, req.params.version);
    if (v.state !== "NEEDS_REVIEW") throw new AppError(409, `version is ${v.state}`);
    await prisma.skillVersion.update({ where: { id: v.id }, data: { state: "REJECTED", reviewedBy: req.auth!.userId, reviewedAt: new Date() } });
    if (strike) await prisma.skillPublisher.update({ where: { id: v.package.publisherId }, data: { strikes: { increment: 1 } } });
    await audit(req, "skill.reject", v.id, { name: v.package.name, version: v.version, reason, strike });
    res.json({ state: "REJECTED" });
  } catch (err) { next(err); }
});

authed.post("/:name/versions/:version/revoke", async (req, res, next) => {
  try {
    await assertAdmin(req.auth!.userId);
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
    const v = await versionFor(req.params.name, req.params.version);
    if (v.state === "REVOKED") throw new AppError(409, "already revoked");
    await prisma.$transaction([
      prisma.skillVersion.update({ where: { id: v.id }, data: { state: "REVOKED", reviewedBy: req.auth!.userId, reviewedAt: new Date() } }),
      prisma.skillRevocation.create({ data: { name: v.package.name, version: v.version, sha256: v.sha256, reason } }),
      prisma.skillReport.updateMany({ where: { versionId: v.id, status: "OPEN" }, data: { status: "ACTIONED" } }),
    ]);
    _resetRevocationCache();
    await audit(req, "skill.revoke", v.id, { name: v.package.name, version: v.version, reason });
    res.json({ state: "REVOKED" });
  } catch (err) { next(err); }
});

authed.post("/publisher/:handle/:action", async (req, res, next) => {
  try {
    await assertAdmin(req.auth!.userId);
    const action = req.params.action;
    if (action !== "verify" && action !== "suspend") throw new AppError(404, "not found");
    const p = await prisma.skillPublisher.update({ where: { handle: req.params.handle }, data: action === "verify" ? { verified: true } : { status: "SUSPENDED" } }).catch(() => null);
    if (!p) throw new AppError(404, "publisher not found");
    await audit(req, `skill.publisher.${action}`, p.id, { handle: p.handle });
    res.json({ publisher: { handle: p.handle, verified: p.verified, status: p.status } });
  } catch (err) { next(err); }
});

skillsRegistryRouter.use(authed);
