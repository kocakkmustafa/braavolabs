import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
    /** Stable, client-localizable machine code (e.g. EMAIL_SENDING_DISABLED). */
    public code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

type StructuralError = {
  type?: string;
  statusCode?: number;
  message?: string;
};

/**
 * Well-known Express / body-parser error codes we want to map to
 * meaningful HTTP statuses instead of leaking as 500.
 */
function mapKnownError(err: unknown): { status: number; message: string } | null {
  const e = (err ?? {}) as StructuralError;
  // body-parser oversized body
  if (e.type === "entity.too.large" || e.statusCode === 413) {
    return { status: 413, message: "Request body too large (max 1MB)" };
  }
  // body-parser invalid JSON
  if (e.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return { status: 400, message: "Invalid JSON in request body" };
  }
  // body-parser unsupported charset
  if (e.type === "charset.unsupported") {
    return { status: 415, message: "Unsupported charset" };
  }
  // CORS-generated errors
  if (e.message?.includes("CORS")) {
    return { status: 403, message: "CORS policy denied this request" };
  }
  return null;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation error",
      details: err.issues,
    });
    return;
  }

  // Known framework errors mapped to proper HTTP status.
  const mapped = mapKnownError(err);
  if (mapped) {
    res.status(mapped.status).json({ error: mapped.message });
    return;
  }

  // Unknown / truly unexpected — log with request context, return 500
  // without leaking stack details to the client.
  logger.error(
    {
      err,
      path: req.path,
      method: req.method,
      requestId: (req as any).requestId,
    },
    "Unhandled error",
  );
  res.status(500).json({
    error: "Internal server error",
    requestId: (req as any).requestId,
  });
}
