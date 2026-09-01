import { defineConfig } from "@playwright/test";

const DEFAULT_PORT = 31_079;
const configuredPort = Number(process.env.BRAAVO_E2E_PORT ?? DEFAULT_PORT);

if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error("BRAAVO_E2E_PORT must be an integer between 1 and 65535");
}

const chromeExecutable =
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "surface-domain.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  outputDir: "test-results/br-p0-000-r1",
  use: {
    baseURL: `http://127.0.0.1:${configuredPort}`,
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: chromeExecutable },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: "node packages/ui/.next/standalone/packages/ui/server.js",
    port: configuredPort,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(configuredPort),
    },
  },
});
