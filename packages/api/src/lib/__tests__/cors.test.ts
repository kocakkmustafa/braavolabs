import { describe, expect, it } from "vitest";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createCorsOptions } from "../cors";

const APEX = "https://braavolabs.com";
const APP = "https://app.braavolabs.com";
const PRODUCTION = { nodeEnv: "production", appUrl: APEX, allowedOrigins: APP };
type PolicyInput = { nodeEnv: string; appUrl: string; allowedOrigins?: string };

async function withServer(input: PolicyInput, check: (url: string) => Promise<void>) {
  const app = express();
  app.use(cors(createCorsOptions(input.nodeEnv, input.appUrl, input.allowedOrigins)));
  // A synthetic read-only route: these tests prove CORS, not user authentication.
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function assertOrigin(url: string, origin: string, allowed: boolean) {
  for (const method of ["GET", "OPTIONS"]) {
    const response = await fetch(url, {
      method,
      headers: method === "GET"
        ? { Origin: origin, Cookie: "bv_access=cors-fixture" }
        : {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization,x-requested-with",
          },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(method === "GET" ? 200 : 204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowed ? origin : null);
    if (allowed) {
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("vary")?.split(/,\s*/)).toContain("Origin");
    }
    if (method === "OPTIONS" && allowed) {
      expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,PATCH,DELETE,OPTIONS");
      expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type,Authorization,X-Requested-With");
      expect(response.headers.get("access-control-max-age")).toBe("86400");
    }
    await response.arrayBuffer();
  }
}

describe("production CORS options used by the API", () => {
  it.each([APEX, APP])("allows exact credentialed GET and preflight from %s", async (origin) => {
    await withServer(PRODUCTION, (url) => assertOrigin(url, origin, true));
  });

  it.each([
    "https://evil.example",
    "https://child.app.braavolabs.com",
    "https://app.braavolabs.com.evil.example",
    "https://app.braavolabs.com:8443",
    "http://app.braavolabs.com",
    "https://www.braavolabs.com",
    "null",
    "http://localhost:3000",
    "http://localhost:3001",
  ])("does not grant browser access to %s", async (origin) => {
    // cors may still return204/credentials:true; missing ACAO is the denial.
    await withServer(PRODUCTION, (url) => assertOrigin(url, origin, false));
  });

  it.each([undefined, ""])("keeps only APP_URL when extras are %s", async (allowedOrigins) => {
    await withServer({ ...PRODUCTION, allowedOrigins }, async (url) => {
      await assertOrigin(url, APEX, true);
      await assertOrigin(url, APP, false);
    });
  });

  it("preserves custom APP_URL and trimmed explicit origins without adding the default", async () => {
    await withServer({
      nodeEnv: "production",
      appUrl: "https://console.example.test",
      allowedOrigins: " , https://review.example.test , ,https://preview.example.test:8443, ",
    }, async (url) => {
      for (const origin of ["https://console.example.test", "https://review.example.test", "https://preview.example.test:8443"]) {
        await assertOrigin(url, origin, true);
      }
      for (const origin of [APP, APEX, "https://preview.example.test"]) {
        await assertOrigin(url, origin, false);
      }
    });
  });

  it.each(["development", "test"])("retains local development origins in %s", async (nodeEnv) => {
    await withServer({ ...PRODUCTION, nodeEnv }, async (url) => {
      await assertOrigin(url, "http://localhost:3000", true);
      await assertOrigin(url, "http://localhost:3001", true);
    });
  });

  it("does not emit an allow-origin header when the request has no Origin", async () => {
    await withServer(PRODUCTION, async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      await response.arrayBuffer();
    });
  });
});
