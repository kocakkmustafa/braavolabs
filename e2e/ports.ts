/**
 * E2E server ports, shared by playwright.config.ts and the specs.
 *
 * Defaults are the CI ports. Override with E2E_API_PORT / E2E_UI_PORT when
 * another workspace on the same machine already owns 4310/4311 — the specs
 * build every URL from these values, so the two can never drift apart.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4310);
export const UI_PORT = Number(process.env.E2E_UI_PORT ?? 4311);
/** Second UI instance (same build) with the BRA-UX-04 prototype flag ON; the default UI above keeps it OFF. */
export const UI_LAB_PORT = Number(process.env.E2E_UI_LAB_PORT ?? 4312);

/** Loopback origin of the real API (request contexts talk to it directly). */
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
/** Public operator authority of the UI (browser resolves it to 127.0.0.1). */
export const UI = `http://operator.example:${UI_PORT}`;
/** Authority of the flag-ON UI instance (BRA-UX-04 prototype at /lab/ux). */
export const UI_LAB = `http://operator.example:${UI_LAB_PORT}`;
