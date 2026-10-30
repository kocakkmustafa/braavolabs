import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../config/env", () => ({ env: { NODE_ENV: "production", OFFLINE_MODE: false } }));

import { sendBatchEmails, sendEmail } from "../email";
import { sendPasswordResetEmail, sendVerifyEmail } from "../email-templates";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(["verify", "reset"])("sends a %s link without SendGrid click or open tracking", async (kind) => {
  vi.stubEnv("SENDGRID_API_KEY", "synthetic-sendgrid-key");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202, headers: { "x-message-id": "synthetic-message" } }));
  vi.stubGlobal("fetch", fetch);
  const url = `https://app.braavolabs.com/${kind}?token=synthetic-secret`;
  if (kind === "verify") await sendVerifyEmail({ to: "synthetic@example.test", verifyUrl: url });
  else await sendPasswordResetEmail({ to: "synthetic@example.test", resetUrl: url });
  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  expect(payload.content[0].value).toContain(`href="${url}"`);
  expect(payload.tracking_settings).toEqual({ click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } });
});

it("retains the existing outreach tracking default", async () => {
  vi.stubEnv("SENDGRID_API_KEY", "synthetic-sendgrid-key");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  await sendEmail({ to: "synthetic@example.test", subject: "Outreach", body: "Synthetic outreach" });
  expect(JSON.parse(fetch.mock.calls[0][1].body).tracking_settings.click_tracking).toEqual({ enable: true });
});

it("B-06: account emails do not depend on OUTBOUND_EMAIL_ENABLED", async () => {
  vi.stubEnv("SENDGRID_API_KEY", "synthetic-sendgrid-key");
  vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "false");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  await sendVerifyEmail({ to: "synthetic@example.test", verifyUrl: "https://app.braavolabs.com/verify?token=x" });
  expect(fetch).toHaveBeenCalledOnce();
});

it("B-06: batch contact email sends nothing unless OUTBOUND_EMAIL_ENABLED=true", async () => {
  vi.stubEnv("SENDGRID_API_KEY", "synthetic-sendgrid-key");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  const batch = [{ to: "a@example.test", subject: "S", body: "B" }, { to: "b@example.test", subject: "S", body: "B" }];

  vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "false");
  expect(await sendBatchEmails(batch)).toEqual({ sent: 0, skipped: 2 });
  expect(fetch).not.toHaveBeenCalled();

  vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
  expect(await sendBatchEmails(batch)).toEqual({ sent: 2, skipped: 0 });
  expect(fetch).toHaveBeenCalledTimes(2);
});
