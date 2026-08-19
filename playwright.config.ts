import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration (BR-P0-005).
 *
 * Boots the REAL API and the REAL Next.js UI against a throwaway Postgres, so
 * `pnpm exec playwright test` is self-contained — no manual setup step that
 * someone can forget and then misread the resulting failure.
 *
 * The database must already exist and be migrated; see e2e/README.md. That is
 * deliberately NOT done here: a config that silently creates and drops
 * databases is a footgun the first time somebody runs it with DATABASE_URL
 * pointing at something real.
 */
const API_PORT = 4310;
const UI_PORT = 4311;
const DB =
  process.env.E2E_DATABASE_URL ??
  `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aicos_e2e`;

const SECRETS = {
  DATABASE_URL: DB,
  JWT_SECRET: "e2e-jwt-secret-at-least-32-characters-long",
  ENCRYPTION_KEY: "e2e-encryption-key-at-least-32-chars",
  NODE_ENV: "test",
};

const chromeExecutable = process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./e2e",
  // Journeys share one database, so parallel workers would race on state
  // (a "no companies yet" assertion fails when another worker just made one).
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    // Artifacts only on failure — a green run should not leave hundreds of MB
    // behind, but a red one must be diagnosable without a re-run.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: chromeExecutable ? { executablePath: chromeExecutable } : undefined,
      },
    },
  ],
  webServer: [
    {
      command: "node packages/api/dist/index.js",
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...process.env, ...SECRETS, API_PORT: String(API_PORT) },
    },
    {
      // Production serves the UI through Next's `output: "standalone"` bundle
      // (ENV/Dockerfile.ui). We deliberately do NOT use it here.
      //
      // On this workspace the standalone server is unusable: `.npmrc` relocates
      // pnpm's virtual store outside iCloud (a required workaround — files
      // under ~/Documents get evicted mid-build), and Next bakes the traced
      // module paths into the bundle at build time. The result resolves
      // node_modules to a .cache path that does not exist and dies with
      // MODULE_NOT_FOUND before serving a byte. That is an artifact of this
      // machine's setup, not of the application.
      //
      // `next start` warns that it "does not work with output: standalone" and
      // then serves the real built app anyway. The application code under test
      // is identical either way — only the server wrapper differs — so this is
      // a faithful harness for journeys. Set E2E_UI_STANDALONE=1 to use the
      // standalone entry instead (correct in CI, which has no relocated store).
      command: process.env.E2E_UI_STANDALONE
        ? `node packages/ui/.next/standalone/packages/ui/server.js`
        : `pnpm --filter @ai-company-os/ui exec next start --port ${UI_PORT}`,
      port: UI_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        ...SECRETS,
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
        HOSTNAME: "127.0.0.1",
        PORT: String(UI_PORT),
      },
    },
  ],
});
