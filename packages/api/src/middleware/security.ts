import type { Request, Response, NextFunction } from "express";

/**
 * Additional security headers beyond what Helmet provides.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // Prevent browsers from MIME-sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Clickjacking protection
  res.setHeader("X-Frame-Options", "DENY");
  // X-XSS-Protection deliberately omitted — non-standard, disabled in
  // every modern browser (Chrome ≥78, Edge ≥17), and "1; mode=block"
  // historically introduced its own XSS vectors via partial reflection.
  // CSP set in next.config.ts is the canonical defense.
  // OWASP recommends sending no value or "0".
  // Referrer policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions policy
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(self)",
  );
  next();
}
