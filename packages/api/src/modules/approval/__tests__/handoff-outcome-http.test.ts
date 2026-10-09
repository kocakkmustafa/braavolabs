/** Actual HTTP/JWT/RBAC/router and optional freshly compiled CLI. Persistence,
 * queue and inference are synthetic; no external service or user config is used.
 * Set BRAAVO_CLI_SOURCE_DIR to run the cross-repository binary contract locally. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const m = vi.hoisted(() => ({
  member: vi.fn(), lookup: vi.fn(), transaction: vi.fn(), claim: vi.fn(),
  runUpdate: vi.fn(), audit: vi.fn(), approvalUpdate: vi.fn(), steering: vi.fn(),
  handoffCancel: vi.fn(), handoffClaim: vi.fn(), enqueue: vi.fn(), inference: vi.fn(), control: vi.fn(),
}));
vi.mock("../../../config/env", () => ({ env: {
  JWT_SECRET: "approval-reason-synthetic-secret-at-least-32",
  AUTH_COOKIE_MODE: false, OFFLINE_MODE: false, NODE_ENV: "test",
} }));
vi.mock("../../../lib/db", () => ({
  prisma: {
    user: { findFirst: m.member }, approval: { findUnique: m.lookup, update: m.approvalUpdate },
    handoffLedger: { updateMany: m.handoffCancel }, run: { update: m.runUpdate },
  },
  tenantTx: m.transaction,
}));
vi.mock("../../../lib/logger", () => ({ logger: {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: m.enqueue }));
vi.mock("../../external/control", () => ({ runControlAction: m.control }));
vi.mock("../../agent/claude", () => ({ runAgentLoop: m.inference }));
vi.mock("../../run/handoff.service", () => ({ claimHandoff: m.handoffClaim, HandoffClaimError: class extends Error {} }));

import { approvalRouter } from "../router";
import { errorHandler } from "../../../middleware/error";
import { currentTenantContext } from "../../../lib/tenant-context";

const tenantId = "synthetic-owner-tenant";
const userId = "synthetic-owner-user";
const secret = "approval-reason-synthetic-secret-at-least-32";
const cliSource = process.env.BRAAVO_CLI_SOURCE_DIR;
let server: http.Server;
let base: string;
let buildRoot: string | undefined;
let bin: string;
let preload: string;
let database: { approval: any; run: any; logs: any[]; answers: any[] };
let role: string;
let transactionTail: Promise<unknown>;
let received: Array<{ path: string; body: unknown; authenticated: boolean }>;
const binaryEvidence: any[] = [];
let compilation: any;

function token() {
  // Deliberately claims OWNER even for the MEMBER case: the real middleware
  // must use the current membership role, not the JWT's stale role.
  return jwt.sign({ userId, tenantId, role: "OWNER" }, secret, { expiresIn: "10m" });
}

function assertTenant() {
  expect(currentTenantContext()).toEqual({ kind: "tenant", tenantId });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    received.push({ path: req.path, body: req.body, authenticated: !!req.headers.authorization });
    next();
  });
  app.use("/api/v1/approvals", approvalRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  if (cliSource) {
    buildRoot = mkdtempSync(join(tmpdir(), "braavo-approval-reason-"));
    bin = join(buildRoot, "dist", "braavo.js");
    preload = join(buildRoot, "isolated.cjs");
    copyFileSync(join(cliSource, "package.json"), join(buildRoot, "package.json"));
    symlinkSync(join(cliSource, "node_modules"), join(buildRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    const cliRequire = createRequire(join(cliSource, "package.json"));
    const args = [cliRequire.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(buildRoot, "dist")];
    const result = spawnSync(process.execPath, args, {
      cwd: cliSource, encoding: "utf8", timeout: 30000,
      env: { PATH: process.env.PATH, LANG: "C" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    compilation = {
      command: [process.execPath, ...args], source: cliSource, exitCode: result.status,
      entrySha256: createHash("sha256").update(readFileSync(bin)).digest("hex"),
      sourceSha256: createHash("sha256").update(readFileSync(join(cliSource, "src/braavo.ts"))).digest("hex"),
    };
    // Only isolate home lookup. fetch is the real Node implementation and the
    // CLI's normal host guard accepts the actual loopback endpoint.
    writeFileSync(preload, 'require("node:os").homedir = () => process.env.BRAAVO_APPROVAL_TEST_HOME;\n');
  }
}, 40000);

afterAll(async () => {
  if (process.env.BRAAVO_APPROVAL_EVIDENCE_FILE) {
    writeFileSync(process.env.BRAAVO_APPROVAL_EVIDENCE_FILE, JSON.stringify({
      compilation, binaryEvidence, realLoopbackHttp: true,
      realJwtAndRbac: true, syntheticPersistence: true, inferenceCalls: m.inference.mock.calls.length,
    }, null, 2) + "\n");
  }
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  received = [];
  role = "OWNER";
  transactionTail = Promise.resolve();
  database = {
    approval: {
      id: "synthetic-approval", runId: "synthetic-run", type: "SPEND", status: "PENDING", amountUsd: 7,
      metadata: { reason: "original approval trigger" },
      run: { pipeline: { company: { tenantId } } },
    },
    run: { status: "AWAITING_APPROVAL" }, logs: [], answers: [],
  };
  m.member.mockImplementation(async ({ where }) => {
    assertTenant();
    return where.id === userId && where.tenantId === tenantId ? { id: userId, tenantId, role } : null;
  });
  m.lookup.mockImplementation(async () => { assertTenant(); return structuredClone(database.approval); });
  m.claim.mockImplementation(async ({ where, data }) => {
    assertTenant();
    expect(where).toEqual({ id: "synthetic-approval", status: "PENDING" });
    if (database.approval.status !== where.status) return { count: 0 };
    Object.assign(database.approval, data);
    return { count: 1 };
  });
  m.runUpdate.mockImplementation(async ({ data }) => { assertTenant(); Object.assign(database.run, data); return database.run; });
  m.audit.mockImplementation(async ({ data }) => {
    assertTenant();
    expect(data.tenantId).toBe(tenantId);
    expect(data.actor).toBe(userId);
    database.logs.push(structuredClone(data)); return data;
  });
  m.approvalUpdate.mockImplementation(async ({ data }) => {
    assertTenant(); Object.assign(database.approval, data); return database.approval;
  });
  m.steering.mockImplementation(async ({ data }) => { assertTenant(); database.answers.push(data); return data; });
  m.transaction.mockImplementation((work) => {
    assertTenant();
    // Serialize winning transitions and roll back all staged data on failure.
    // This models transaction behavior; it does not claim real SQL/RLS evidence.
    const pending = transactionTail.then(async () => {
      const snapshot = structuredClone(database);
      try {
        return await work({
          approval: { updateMany: m.claim, update: m.approvalUpdate },
          run: { update: m.runUpdate }, activityLog: { create: m.audit }, steeringMessage: { create: m.steering },
        });
      } catch (err) { database = snapshot; throw err; }
    });
    transactionTail = pending.catch(() => undefined);
    return pending;
  });
  m.enqueue.mockResolvedValue(undefined);
  m.handoffCancel.mockResolvedValue({ count: 1 });
});

async function decide(body: Record<string, unknown>, authorization: string | null = token()) {
  return fetch(`${base}/approvals/synthetic-approval/decide`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
    body: JSON.stringify(body),
  });
}

function noWork() {
  expect(m.enqueue).not.toHaveBeenCalled();
  expect(m.inference).not.toHaveBeenCalled();
  expect(m.control).not.toHaveBeenCalled();
}

async function runCli(args: string[], authenticated = true) {
  const home = mkdtempSync(join(buildRoot!, "home-"));
  mkdirSync(join(home, ".braavo"), { mode: 0o700 });
  writeFileSync(join(home, ".braavo/config.json"), JSON.stringify({ apiUrl: base, ...(authenticated ? { token: token() } : {}) }), { mode: 0o600 });
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--require", preload, bin, ...args], {
      cwd: home, env: { PATH: process.env.PATH, LANG: "C", TERM: "dumb", NO_COLOR: "1", BRAAVO_APPROVAL_TEST_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI timeout")); }, 10000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (err) => { clearTimeout(timeout); reject(err); });
    child.once("close", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
  });
  binaryEvidence.push({ args, result, requests: structuredClone(received),
    audit: structuredClone(database.logs), approvalStatus: database.approval.status,
    runStatus: database.run.status, enqueueCalls: m.enqueue.mock.calls.length, inferenceCalls: m.inference.mock.calls.length });
  return result;
}

describe.skipIf(!cliSource)("compiled CLI actual authenticated handoff HTTP outcome", () => {
  beforeEach(() => {
    database.approval.type = "HANDOFF";
    database.approval.metadata = { handoffId: "synthetic-handoff", suggestedProvider: "OPENAI", suggestedModel: "gpt-4o" };
    database.run.status = "FAILED";
    m.handoffClaim.mockResolvedValue({ id: "synthetic-handoff", status: "CLAIMED" });
  });
  it.each([true, false])("committed approval + claim refusal shows failure, retains audit, never retries/inferences (json=%s)", async json => {
    m.handoffClaim.mockRejectedValue(new Error("not frozen"));
    const result = await runCli(["approve", "synthetic-approval", "--yes", "--reason", "operator rationale", ...(json ? ["--json"] : [])]);
    expect(result.status).toBe(7);
    if (json) expect(JSON.parse(result.stdout)).toMatchObject({ decision: "APPROVED", result: { success: true, decision: "APPROVED", claimFailed: true, error: "not frozen" } });
    else { expect(result.stdout).toMatch(/handoff.*(incomplete|attention|failed|blocked)/i); expect(result.stdout).toContain("not frozen"); }
    expect(database.approval.status).toBe("APPROVED"); expect(database.run.status).toBe("FAILED");
    expect(database.logs).toHaveLength(1); expect(database.logs[0].details.reason).toBe("operator rationale");
    expect(received).toHaveLength(1); expect(m.handoffClaim).toHaveBeenCalledOnce(); noWork();
  });
  it("true success enqueues one synthetic intent and never invokes inference", async () => {
    const result = await runCli(["approve", "synthetic-approval", "--yes", "--json"]);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).result).toEqual({ success: true, decision: "APPROVED" });
    expect(database.approval.status).toBe("APPROVED"); expect(database.run.status).toBe("RUNNING");
    expect(m.enqueue).toHaveBeenCalledOnce(); expect(m.inference).not.toHaveBeenCalled(); expect(received).toHaveLength(1);
  });
  it("post-claim enqueue failure is incomplete without inventing an unclaimed ledger", async () => {
    m.enqueue.mockRejectedValue(new Error("synthetic queue unavailable"));
    const result = await runCli(["approve", "synthetic-approval", "--yes", "--json"]);
    expect(result.status).toBe(7); expect(JSON.parse(result.stdout).result).toMatchObject({ success: true, decision: "APPROVED", claimFailed: true, error: "synthetic queue unavailable" });
    expect(m.handoffClaim).toHaveBeenCalledOnce(); expect(m.enqueue).toHaveBeenCalledOnce(); expect(m.inference).not.toHaveBeenCalled(); expect(received).toHaveLength(1);
  });
  it("rejection cancels the ledger without claim, enqueue or inference", async () => {
    const result = await runCli(["approve", "synthetic-approval", "--deny", "--yes", "--json"]);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).result).toEqual({ success: true, decision: "REJECTED" });
    expect(database.approval.status).toBe("REJECTED"); expect(database.run.status).toBe("FAILED");
    expect(m.handoffClaim).not.toHaveBeenCalled(); expect(m.handoffCancel).toHaveBeenCalledOnce(); noWork();
  });
  it("a repeated already-committed approval is refused without repeating claim or dispatch", async () => {
    m.handoffClaim.mockRejectedValue(new Error("not frozen"));
    await runCli(["approve", "synthetic-approval", "--yes", "--json"]);
    const second = await runCli(["approve", "synthetic-approval", "--yes", "--json"]);
    expect(second.status).not.toBe(0); expect(second.stdout).toBe(""); expect(database.logs).toHaveLength(1);
    expect(m.handoffClaim).toHaveBeenCalledOnce(); noWork();
  });
  it("validation failure performs no transaction, claim, enqueue, inference or retry", async () => {
    const result = await runCli(["approve", "synthetic-approval", "--yes", "--reason", "r".repeat(4001), "--json"]);
    expect(result.status).not.toBe(0); expect(result.stdout).toBe(""); expect(m.transaction).not.toHaveBeenCalled();
    expect(m.handoffClaim).not.toHaveBeenCalled(); expect(received).toHaveLength(1); noWork();
  });
});
