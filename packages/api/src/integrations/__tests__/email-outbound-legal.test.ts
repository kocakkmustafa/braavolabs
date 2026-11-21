import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../config/env", () => ({
  env: {
    NODE_ENV: "production",
    OFFLINE_MODE: false,
    JWT_SECRET: "test-jwt-secret-at-least-32-characters-long-xx",
    API_PUBLIC_URL: "https://api.example.test",
  },
}));

import { sendEmail } from "../email";
import { sendVerifyEmail } from "../email-templates";
import { verifyUnsubscribeToken } from "../../lib/unsubscribe-token";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202, headers: { "x-message-id": "m1" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SENDGRID_API_KEY", "synthetic-sendgrid-key");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const msg = { to: "Lead@Example.test ", subject: "S", body: "B" };

function configure() {
  vi.stubEnv("OUTBOUND_LEGAL_SENDER_ADDRESS", "Test Street 1, Test City");
  vi.stubEnv("OUTBOUND_LEGAL_UNSUBSCRIBE_TEXT", "Opt out: {url}");
}

describe("outbound email legal headers", () => {
  it("adds List-Unsubscribe (https, signed) and One-Click post header", async () => {
    configure();
    await sendEmail({ ...msg, outbound: { tenantId: "tenant-1" } });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const header = payload.headers["List-Unsubscribe"] as string;
    expect(header).toMatch(/^<https:\/\/api\.example\.test\/api\/v1\/public\/unsubscribe\?token=[^>]+>$/);
    const token = decodeURIComponent(header.slice(header.indexOf("token=") + 6, -1));
    expect(verifyUnsubscribeToken(token)).toEqual({ tenantId: "tenant-1", email: "lead@example.test" });
  });

  it.each([["OUTBOUND_LEGAL_SENDER_ADDRESS"], ["OUTBOUND_LEGAL_UNSUBSCRIBE_TEXT"]])(
    "%s missing: refused with LEGAL_CONFIG_MISSING before any provider call",
    async (name) => {
      configure();
      vi.stubEnv(name, "");
      await expect(sendEmail({ ...msg, outbound: { tenantId: "tenant-1" } }))
        .rejects.toMatchObject({ statusCode: 422, code: "LEGAL_CONFIG_MISSING" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses even without a SendGrid key (no silent dev no-op)", async () => {
    vi.stubEnv("SENDGRID_API_KEY", "");
    await expect(sendEmail({ ...msg, outbound: { tenantId: "tenant-1" } }))
      .rejects.toMatchObject({ code: "LEGAL_CONFIG_MISSING" });
  });

  it("account emails are unchanged: no headers field, no legal config needed", async () => {
    await sendVerifyEmail({ to: "a@example.test", verifyUrl: "https://app.example.test/v?t=1" });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect("headers" in payload).toBe(false);
  });

  it("a plain sendEmail (no outbound marker) keeps today's payload", async () => {
    await sendEmail(msg);
    expect("headers" in JSON.parse(fetchMock.mock.calls[0][1].body)).toBe(false);
  });
});
