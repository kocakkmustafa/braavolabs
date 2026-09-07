import { ApiRequestError } from "./api";

/** Public auth forms expose localized categories, never raw server messages. */
export function authErrorKey(error: unknown, options: { credentials?: boolean } = {}) {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 && options.credentials) return "auth.errors.invalidCredentials";
    if (error.status === 429) return "auth.errors.rateLimited";
    if (error.status >= 500 && error.status < 600) return "auth.errors.unavailable";
  }
  return "auth.errors.generic";
}
