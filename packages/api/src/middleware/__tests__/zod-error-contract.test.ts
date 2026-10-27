import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { validate, validateQuery } from "../validate";
import { errorHandler } from "../error";

/**
 * BRV-27 (zod 3 → 4): the 400 bodies clients read. The web form shows
 * `message` ("field: reason"), so custom messages must survive the major;
 * zod's own default wording and issue fields (code, format, origin) follow
 * zod 4 and are not part of the contract.
 */
function mockRes() {
  const res = { statusCode: 0, body: undefined as unknown } as Response & { body: unknown };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => { res.body = body; return res; }) as unknown as Response["json"];
  return res;
}

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

describe("zod error response contract", () => {
  it("validate(): 400 with 'path: message' text and the raw issues", () => {
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    validate(schema)({ body: { email: "a@b.co", password: "short" } } as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: "Validation failed",
      message: "password: Password must be at least 8 characters",
      statusCode: 400,
      issues: [{ code: "too_small", path: ["password"], message: "Password must be at least 8 characters" }],
    });
  });

  it("validate(): replaces the body with parsed output (unknown keys stripped)", () => {
    const req = { body: { email: "a@b.co", password: "long-enough", role: "admin" } } as Request;
    const next = vi.fn() as unknown as NextFunction;
    validate(schema)(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({ email: "a@b.co", password: "long-enough" });
  });

  it("validateQuery(): assigns coerced query values", () => {
    const req = { query: { limit: "25" } } as unknown as Request;
    validateQuery(z.object({ limit: z.coerce.number().int().max(100) }))(req, mockRes(), vi.fn() as unknown as NextFunction);
    expect(req.query).toEqual({ limit: 25 });
  });

  it("errorHandler: a thrown ZodError becomes 400 with the issues as details", () => {
    const res = mockRes();
    const err = schema.safeParse({ email: "nope", password: "long-enough" }).error!;
    errorHandler(err, {} as Request, res, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(400);
    const body = res.body as { error: string; details: Array<{ path: string[]; code: string }> };
    expect(body.error).toBe("Validation error");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatchObject({ path: ["email"], code: "invalid_format" });
  });

  it("the `error` option keeps one custom message for missing and wrong values", () => {
    // Replaces zod 3 `errorMap` (users DELETE /me confirm) and
    // `invalid_type_error` (agent PATCH config) in the routers.
    const confirm = z.object({ confirm: z.literal("DELETE", { error: "send DELETE" }) });
    expect(confirm.safeParse({}).error!.issues[0].message).toBe("send DELETE");
    expect(confirm.safeParse({ confirm: "delete" }).error!.issues[0].message).toBe("send DELETE");
    const never = z.object({ config: z.never({ error: "not supported" }).optional() });
    expect(never.safeParse({ config: {} }).error!.issues[0].message).toBe("not supported");
    expect(never.safeParse({}).success).toBe(true);
  });
});
