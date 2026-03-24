/**
 * Zod validation middleware factory.
 * Usage: router.post("/", validate(schema), handler)
 */

import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        statusCode: 400,
        issues: result.error.issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        statusCode: 400,
      });
      return;
    }
    req.query = result.data;
    next();
  };
}

export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        statusCode: 400,
      });
      return;
    }
    next();
  };
}
