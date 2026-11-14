/**
 * QA-BRA-01 — REST sözleşme testi.
 *   1. docs/openapi-draft.yaml ile zod sözleşmesi (rest-contract.ts) aynı şekli anlatır.
 *   2. Gerçek router işleyicileri (GET /runs, GET /approvals) sözleşmeye uyan gövde/başlık döner.
 *   3. Hata gövdesi her durumda { error: string }.
 * Üretim kodu değişmez; ihlal bulunursa burada kırılır.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z, ZodError } from "zod";
import type { Router } from "express";
import { INBOX_BUCKETS } from "@ai-company-os/core";

const runFindMany = vi.hoisted(() => vi.fn());
const approvalFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/db", () => ({
  prisma: {
    run: { findMany: (...a: unknown[]) => runFindMany(...a) },
    approval: { findMany: (...a: unknown[]) => approvalFindMany(...a) },
    draft: { findFirst: vi.fn().mockResolvedValue(null) },
  },
  tenantTx: vi.fn(),
}));
vi.mock("../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../middleware/require-permission", () => ({ requirePermission: () => (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../modules/pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../modules/external/control", () => ({ runControlAction: vi.fn() }));
vi.mock("../../services/ai-client", async (orig) => ({ ...(await orig<typeof import("../../services/ai-client")>()), chatCompletion: vi.fn() }));
vi.mock("../../services/provider-chain", async (orig) => ({
  ...(await orig<typeof import("../../services/provider-chain")>()),
  listTenantProviderLinks: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../services/takeover-config", () => ({ assertKeylessLocalBaseUrl: vi.fn() }));
vi.mock("../../modules/run/handoff.service", () => ({
  createHandoff: vi.fn(), claimHandoff: vi.fn(), cancelOpenHandoffForRun: vi.fn(), reopenClaimedHandoff: vi.fn(),
  HandoffClaimError: class HandoffClaimError extends Error {},
}));
vi.mock("../../config/env", () => ({
  env: { NODE_ENV: "test", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5" },
}));

import { runRouter } from "../../modules/run/router";
import { approvalRouter } from "../../modules/approval/router";
import { AppError, errorHandler } from "../../middleware/error";
import {
  APPROVAL_STATUS_VALUES, ApprovalsArrayResponseSchema, ApprovalsGroupedResponseSchema, COMPONENT_SCHEMAS,
  ErrorBodySchema, INBOX_BUCKET_VALUES, LIMIT_DEFAULT, LIMIT_MAX, LIMIT_MIN, NEXT_CURSOR_HEADER, RunsListResponseSchema,
} from "./rest-contract";

// ─── OpenAPI taslağı ↔ zod ──────────────────────────────────────────────
const doc = parse(readFileSync(join(__dirname, "../../../../../docs/openapi-draft.yaml"), "utf8")) as any;

interface Canon { t: string[]; enum?: unknown[]; props?: Record<string, Canon>; req?: string[]; items?: Canon }

function canon(node: any, root: any): Canon {
  if (node.$ref) return canon(root.components.schemas[String(node.$ref).split("/").pop()!], root);
  if (node.anyOf || node.oneOf) {
    const parts = (node.anyOf ?? node.oneOf).map((p: any) => canon(p, root)) as Canon[];
    const nonNull = parts.filter((p) => !(p.t.length === 1 && p.t[0] === "null"));
    const t = [...new Set(parts.flatMap((p) => p.t))].sort();
    return nonNull.length === 1 ? { ...nonNull[0], t } : { t };
  }
  const out: Canon = { t: [].concat(node.type ?? []).slice().sort() };
  if (node.enum) out.enum = node.enum.filter((v: unknown) => v !== null).slice().sort();
  if (node.properties) {
    out.props = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, canon(v, root)]));
  }
  if (node.required?.length) out.req = [...node.required].sort();
  if (node.items) out.items = canon(node.items, root);
  return out;
}

describe("openapi-draft.yaml ↔ zod sözleşmesi", () => {
  for (const [name, schema] of Object.entries(COMPONENT_SCHEMAS)) {
    it(`components.schemas.${name} zod ile aynı şekil`, () => {
      const fromZod = canon(z.toJSONSchema(schema, { io: "output" }), {});
      const fromDoc = canon({ $ref: `#/components/schemas/${name}` }, doc);
      expect(fromDoc).toEqual(fromZod);
    });
  }

  it("taslakta tam olarak sözleşmedeki bileşenler var", () => {
    expect(Object.keys(doc.components.schemas).sort()).toEqual(Object.keys(COMPONENT_SCHEMAS).sort());
  });

  it("uçlar: yalnız GET /runs ve GET /approvals; sorgu parametreleri ve sınırlar eşleşir", () => {
    expect(Object.keys(doc.paths).sort()).toEqual(["/approvals", "/runs"]);
    const params = (p: string) => Object.fromEntries(doc.paths[p].get.parameters.map((x: any) => [x.name, x.schema]));
    const runs = params("/runs");
    expect(Object.keys(runs).sort()).toEqual(["bucket", "cursor", "limit"]);
    expect(runs.bucket.enum).toEqual([...INBOX_BUCKET_VALUES]);
    const apr = params("/approvals");
    expect(Object.keys(apr).sort()).toEqual(["cursor", "groupBy", "limit", "status"]);
    expect(apr.status.enum).toEqual([...APPROVAL_STATUS_VALUES]);
    expect(apr.status.default).toBe("PENDING");
    expect(apr.groupBy.enum).toEqual(["run"]);
    for (const l of [runs.limit, apr.limit]) {
      expect([l.minimum, l.maximum, l.default]).toEqual([LIMIT_MIN, LIMIT_MAX, LIMIT_DEFAULT]);
    }
  });

  it("taslak yanıtları: 200 şeması, 400 = ErrorBody, X-Next-Cursor başlığı", () => {
    for (const p of ["/runs", "/approvals"]) {
      expect(doc.paths[p].get.responses["400"].content["application/json"].schema.$ref).toBe("#/components/schemas/ErrorBody");
    }
    expect(doc.paths["/runs"].get.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/RunsListResponse");
    const ok = doc.paths["/approvals"].get.responses["200"];
    expect(Object.keys(ok.headers)).toEqual([NEXT_CURSOR_HEADER]);
    expect(ok.content["application/json"].schema.oneOf).toHaveLength(2);
  });

  it("sözleşme sabitleri üretimle aynı: inbox kovaları ve CORS exposedHeaders", () => {
    expect([...INBOX_BUCKET_VALUES]).toEqual([...INBOX_BUCKETS]);
    expect(readFileSync(join(__dirname, "../../lib/cors.ts"), "utf8")).toContain(`exposedHeaders: ["${NEXT_CURSOR_HEADER}"]`);
  });
});

// ─── Gerçek işleyiciler ─────────────────────────────────────────────────
function getHandler(router: Router, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route && l.route.path === path && l.route.methods.get);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}

async function call(router: Router, query: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200, body: undefined,
    setHeader(k: string, v: string) { headers[k] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = JSON.parse(JSON.stringify(p)); return this; }, // tel biçimi
  };
  let nextErr: any;
  await getHandler(router, "/")({ auth: { tenantId: "t1", userId: "u", role: "admin" }, query }, res, (e?: any) => { nextErr = e; });
  return { res, headers, nextErr };
}

/** Hata ara katmanından geçirip tel gövdesini döndürür. */
function viaErrorHandler(err: Error) {
  const res: any = { statusCode: 0, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = JSON.parse(JSON.stringify(p)); return this; } };
  errorHandler(err, { path: "/x", method: "GET" } as any, res, () => {});
  return res;
}

const at = (i: number) => new Date(Date.UTC(2026, 10, 9, 10, 0, 60 - i));
function runRow(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `run-${i}`, pipelineId: "p1", status: "COMPLETED", state: "COMPLETED", resultStatus: "SUCCESS", trigger: "manual",
    costUsd: "0.120000", startedAt: at(i), completedAt: at(i), heartbeatAt: null, createdAt: at(i), updatedAt: at(i),
    pipeline: { id: "p1", name: "Pipe", company: { id: "c1", name: "Co" } }, ...over,
  };
}
function apRow(i: number) {
  return {
    id: `ap-${i}`, runId: `run-${i}`, type: "SPEND", status: "PENDING", description: "d", amountUsd: null, metadata: { toolName: "t", secret: "x" },
    decidedBy: null, decidedAt: null, expiresAt: null, createdAt: at(i),
    run: { id: `run-${i}`, pipeline: { id: "p", name: `Pipe ${i}`, company: { id: "c", name: "Co", slug: "co", config: {} } } },
  };
}

beforeEach(() => {
  runFindMany.mockReset().mockResolvedValue([]);
  approvalFindMany.mockReset().mockResolvedValue([]);
});

describe("GET /runs yanıt zarfı", () => {
  it("{runs,nextCursor}: tam sayfa → imleç string; bucket enum; gövde şemaya uyar", async () => {
    runFindMany.mockResolvedValue([runRow(1), runRow(2), runRow(3)]);
    const { res, headers } = await call(runRouter, { limit: "2" });
    expect(RunsListResponseSchema.parse(res.body).runs).toHaveLength(2);
    expect(typeof res.body.nextCursor).toBe("string");
    expect(headers[NEXT_CURSOR_HEADER]).toBeUndefined(); // runs: imleç yalnız gövdede
  });

  it("son sayfa: nextCursor null; boş liste de geçerli", async () => {
    runFindMany.mockResolvedValue([runRow(1, { state: null, resultStatus: null, costUsd: null, startedAt: null, completedAt: null })]);
    const { res } = await call(runRouter, {});
    expect(RunsListResponseSchema.parse(res.body).nextCursor).toBeNull();
    runFindMany.mockResolvedValue([]);
    expect(RunsListResponseSchema.parse((await call(runRouter, {})).res.body)).toEqual({ runs: [], nextCursor: null });
  });

  it("ham Run sütunu / Company.config sızmaz: öğe anahtarları sözleşmedeki kümeyle birebir", async () => {
    runFindMany.mockResolvedValue([runRow(1)]);
    const { res } = await call(runRouter, {});
    const keys = Object.keys(res.body.runs[0]).sort();
    expect(keys).toEqual(Object.keys(COMPONENT_SCHEMAS.RunListItem.shape).sort());
  });
});

describe("GET /approvals yanıt zarfı", () => {
  it("parametresiz: düz dizi, başlık yok", async () => {
    approvalFindMany.mockResolvedValue([apRow(1), apRow(2)]);
    const { res, headers } = await call(approvalRouter, {});
    expect(ApprovalsArrayResponseSchema.parse(res.body)).toHaveLength(2);
    expect(res.body[0].metadata).toEqual({ toolName: "t" }); // ham metadata sızmaz
    expect(headers[NEXT_CURSOR_HEADER]).toBeUndefined();
  });

  it("limit: gövde dizi, imleç X-Next-Cursor başlığında", async () => {
    approvalFindMany.mockResolvedValue([apRow(1), apRow(2), apRow(3)]);
    const { res, headers } = await call(approvalRouter, { limit: "2" });
    expect(ApprovalsArrayResponseSchema.parse(res.body)).toHaveLength(2);
    expect(typeof headers[NEXT_CURSOR_HEADER]).toBe("string");
  });

  it("groupBy=run: {groups,nextCursor}, imleç gövdede, başlık yok", async () => {
    approvalFindMany.mockResolvedValue([apRow(1), apRow(2), apRow(3)]);
    const { res, headers } = await call(approvalRouter, { groupBy: "run", limit: "2" });
    const parsed = ApprovalsGroupedResponseSchema.parse(res.body);
    expect(parsed.groups.length).toBeGreaterThan(0);
    expect(typeof parsed.nextCursor).toBe("string");
    expect(headers[NEXT_CURSOR_HEADER]).toBeUndefined();
  });
});

describe("hata gövdesi { error }", () => {
  const badRuns = [{ bucket: "x" }, { limit: "0" }, { limit: "101" }, { cursor: "zzz" }];
  const badApprovals = [{ status: "bogus" }, { groupBy: "company" }, { limit: "x" }, { cursor: "zzz" }];

  it.each([...badRuns.map((q) => [runRouter, q] as const), ...badApprovals.map((q) => [approvalRouter, q] as const)])(
    "geçersiz sorgu %#: AppError 400 → ErrorBody",
    async (router, q) => {
      const { nextErr } = await call(router, q);
      expect(nextErr).toBeInstanceOf(AppError);
      const res = viaErrorHandler(nextErr);
      expect(res.statusCode).toBe(400);
      expect(ErrorBodySchema.parse(res.body).error).toEqual(expect.any(String));
    },
  );

  it("ZodError, bilinmeyen hata ve kodlu AppError de { error } taşır", () => {
    const zerr = (() => { try { z.string().parse(1); } catch (e) { return e as ZodError; } throw new Error("unreachable"); })();
    for (const [err, status] of [[zerr, 400], [new Error("boom"), 500], [new AppError(409, "çakışma", undefined, "CONFLICT"), 409]] as const) {
      const res = viaErrorHandler(err);
      expect(res.statusCode).toBe(status);
      expect(ErrorBodySchema.parse(res.body).error).toEqual(expect.any(String));
    }
    expect(viaErrorHandler(new Error("boom")).body.error).toBe("Internal server error"); // iç ayrıntı sızmaz
  });
});
