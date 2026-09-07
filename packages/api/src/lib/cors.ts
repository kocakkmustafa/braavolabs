import type { CorsOptions } from "cors";

// Keep the existing policy independent of boot-time services so the real
// middleware contract can be tested without starting workers or a database.
export function createCorsOptions(
  nodeEnv: string,
  appUrl: string,
  allowedOrigins?: string,
): CorsOptions {
  const extras = (allowedOrigins ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    origin: nodeEnv === "production"
      ? [appUrl, ...extras]
      : [appUrl, "http://localhost:3000", "http://localhost:3001", ...extras],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Cookie-mode requests retain the explicit CSRF custom-header preflight.
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    maxAge: 86400,
  };
}
