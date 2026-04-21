import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * Well-known Express / body-parser error codes we want to map to
 * meaningful HTTP statuses instead of leaking as 500.
 */
function mapKnownError(err: any): { status: number; message: string } | null {
  // body-parser oversized body
  if (err?.type === "entity.too.large" || err?.statusCode === 413) {
    return { status: 413, message: "Request body too large (max 1MB)" };
  }
  // body-parser invalid JSON
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return { status: 400, message: "Invalid JSON in request body" };
  }
  // body-parser unsupported charset
  if (err?.type === "charset.unsupported") {
    return { status: 415, message: "Unsupported charset" };
  }
  // CORS-generated errors
  if (err?.message?.includes("CORS")) {
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
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation error",
      details: err.errors,
    });
    return;
  }

  // Known framework errors mapped to proper HTTP status.
  const mapped = mapKnownError(err as any);
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
