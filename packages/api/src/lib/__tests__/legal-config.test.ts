import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/env", () => ({
  env: { JWT_SECRET: "test-jwt-secret-at-least-32-characters-long-xx", API_PUBLIC_URL: "https://api.example.test" },
}));
vi.mock("../db", () => ({ prisma: {} }));

import {
  getOutboundLegalConfig,
  isWithinCallWindow,
  missingEmailLegalConfig,
  missingVoiceLegalConfig,
  parseCallWindow,
} from "../outbound-gates";
import { createUnsubscribeToken, UNSUBSCRIBE_TOKEN_TTL_SECONDS, verifyUnsubscribeToken } from "../unsubscribe-token";
import { isSpamLimitReached } from "../spam-guard";

afterEach(() => { vi.unstubAllEnvs(); });

describe("getOutboundLegalConfig", () => {
  it("is all null when nothing is configured (the production default)", () => {
    for (const n of ["OUTBOUND_LEGAL_SENDER_ADDRESS", "OUTBOUND_LEGAL_UNSUBSCRIBE_TEXT", "VOICE_AI_DISCLOSURE_TEXT", "VOICE_CALL_WINDOW"]) {
      delete process.env[n];
    }
    expect(getOutboundLegalConfig()).toEqual({
      senderAddress: null, unsubscribeText: null, voiceDisclosure: null, voiceCallWindow: null,
    });
    expect(missingEmailLegalConfig()).toHaveLength(2);
    expect(missingVoiceLegalConfig()).toHaveLength(2);
  });

  it("treats whitespace-only values as missing and requires {url}", () => {
    vi.stubEnv("OUTBOUND_LEGAL_SENDER_ADDRESS", "   ");
    vi.stubEnv("OUTBOUND_LEGAL_UNSUBSCRIBE_TEXT", "no placeholder");
    const c = getOutboundLegalConfig();
    expect(c.senderAddress).toBeNull();
    expect(c.unsubscribeText).toBeNull();
  });

  it("rejects an over-long disclosure and an invalid window", () => {
    vi.stubEnv("VOICE_AI_DISCLOSURE_TEXT", "x".repeat(301));
    vi.stubEnv("VOICE_CALL_WINDOW", "20:00-09:00");
    const c = getOutboundLegalConfig();
    expect(c.voiceDisclosure).toBeNull();
    expect(c.voiceCallWindow).toBeNull();
  });
});

describe("call window", () => {
  it("parses with and without a zone", () => {
    expect(parseCallWindow("09:00-20:00")).toMatchObject({ startMinutes: 540, endMinutes: 1200, timeZone: "UTC" });
    expect(parseCallWindow("09:00-20:00 Europe/Istanbul")).toMatchObject({ timeZone: "Europe/Istanbul" });
    for (const bad of ["", "9-20", "09:00-09:00", "25:00-26:00", "09:00-20:00 Not/AZone", "09:00-20:00 foo bar"]) {
      expect(parseCallWindow(bad)).toBeNull();
    }
  });

  it("start inclusive, end exclusive, in the window's zone", () => {
    const utc = parseCallWindow("09:00-20:00")!;
    expect(isWithinCallWindow(utc, new Date("2026-11-21T08:59:00Z"))).toBe(false);
    expect(isWithinCallWindow(utc, new Date("2026-11-21T09:00:00Z"))).toBe(true);
    expect(isWithinCallWindow(utc, new Date("2026-11-21T19:59:00Z"))).toBe(true);
    expect(isWithinCallWindow(utc, new Date("2026-11-21T20:00:00Z"))).toBe(false);
    const ist = parseCallWindow("09:00-20:00 Europe/Istanbul")!; // UTC+3
    expect(isWithinCallWindow(ist, new Date("2026-11-21T06:00:00Z"))).toBe(true);
    expect(isWithinCallWindow(ist, new Date("2026-11-21T05:59:00Z"))).toBe(false);
  });
});

describe("unsubscribe token", () => {
  it("round-trips and normalises the email", () => {
    expect(verifyUnsubscribeToken(createUnsubscribeToken("t1", "  A@B.test "))).toEqual({ tenantId: "t1", email: "a@b.test" });
  });
  it("rejects tamper, wrong signature, garbage and non-strings", () => {
    const token = createUnsubscribeToken("t1", "a@b.test");
    const [p, s] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ t: "t2", e: "a@b.test", x: 9999999999 })).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${s}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${p}.${s.slice(0, -2)}xx`)).toBeNull();
    for (const bad of ["", "x", "a.b.c", undefined, null, 5, {}, "x".repeat(2000)]) {
      expect(verifyUnsubscribeToken(bad)).toBeNull();
    }
  });
  it("expires", () => {
    const now = Date.now();
    const token = createUnsubscribeToken("t1", "a@b.test", now);
    expect(verifyUnsubscribeToken(token, now + (UNSUBSCRIBE_TOKEN_TTL_SECONDS - 5) * 1000)).not.toBeNull();
    expect(verifyUnsubscribeToken(token, now + (UNSUBSCRIBE_TOKEN_TTL_SECONDS + 5) * 1000)).toBeNull();
  });
});

describe("spam guard threshold", () => {
  it("trips at 3", () => {
    expect([0, 1, 2, 3, 4].map(isSpamLimitReached)).toEqual([false, false, false, true, true]);
  });
});
