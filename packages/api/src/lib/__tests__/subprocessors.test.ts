import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The subprocessor data map must be DERIVED, not written down (BR-P1-005 #4,
 * roadmap §7.4: "Web, desktop, CLI ve mobile için gerçek data map",
 * "Processor purpose, transfer, retention ve deletion").
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS
 *
 *   - `ui/app/gdpr/page.tsx` has eight sections and none of them is a
 *     subprocessor list. The word does not appear in the file.
 *   - The app accepts credentials for Stripe, SendGrid, Sentry, Apple,
 *     Google, GitHub, RevenueCat, Vapi and four LLM vendors, and discloses
 *     none of them by name.
 *
 * A hand-maintained list is a claim that rots: the next integration ships and
 * the page silently becomes false, which for a processing disclosure is not a
 * stale doc but a wrong statement to a data subject.
 *
 * The declaration lives in `@ai-company-os/core` so the public GDPR page can
 * render it statically — a legal disclosure that only appears when an API
 * call succeeds is not a disclosure. THIS gate is what keeps it honest, and
 * it lives here because the API package is the only place that can see both
 * the declaration and the real provider registry. Two rules:
 *
 *   - every CLOUD provider in PROVIDER_INFO must be declared, and no LOCAL
 *     one may be;
 *   - every third-party credential the application accepts must resolve to a
 *     declared subprocessor, or be marked first-party WITH a reason.
 *
 * Adding an integration means adding a credential, which is the moment this
 * has to change — rather than whenever someone next remembers the page.
 */

const API_SRC = join(__dirname, "..", "..");
const REPO = join(API_SRC, "..", "..", "..");
const ENV_SRC = readFileSync(join(API_SRC, "config", "env.ts"), "utf8");
/**
 * The operator-facing contract, which is where several live credentials sit.
 * Reading only `env.ts` was the hole: HubSpot, Tavily, Serper and Brave are
 * dialled from `process.env` directly and declared nowhere the gate looked.
 */
const ENV_EXAMPLE = readFileSync(join(REPO, ".env.example"), "utf8");

/** Credential-shaped env vars: each one implies someone we talk to. */
function credentialVars(): string[] {
  const fromSchema = [...ENV_SRC.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  const fromExample = [...ENV_EXAMPLE.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  return [...new Set([...fromSchema, ...fromExample])]
    // BACKUP_S3_ is in the filter because it is not credential-SHAPED and yet
    // it names the bucket holding a complete database dump. The original
    // filter missed it entirely: "does the name contain SECRET" is a proxy for
    // "is there a recipient", and the proxy leaked.
    .filter((n) => /KEY|SECRET|TOKEN|WEBHOOK|DSN|SERVICE_ACCOUNT|BACKUP_S3/.test(n));
}

describe("subprocessor data map (BR-P1-005 #4)", () => {
  it("covers every CLOUD model provider, derived rather than transcribed", async () => {
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    const { PROVIDER_INFO } = await import("../../services/ai-client");

    const cloud = Object.entries(PROVIDER_INFO)
      .filter(([, v]) => v.privacy === "cloud")
      .map(([k]) => k);
    expect(cloud.length, "expected the cloud providers to be found").toBeGreaterThan(5);

    const declared = new Set(SUBPROCESSORS.map((s) => s.id));
    for (const p of cloud) {
      expect(declared, `cloud provider ${p} is not in the data map`).toContain(`llm:${p}`);
    }
  });

  it("excludes LOCAL providers — that distinction is the point", async () => {
    // roadmap §7.4 "Local/BYOK/cloud/managed ayrımı". Listing Ollama as a
    // subprocessor would be false: nothing leaves the user's machine.
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    const { PROVIDER_INFO } = await import("../../services/ai-client");
    const declared = new Set(SUBPROCESSORS.map((s) => s.id));
    for (const [k, v] of Object.entries(PROVIDER_INFO)) {
      if (v.privacy === "local") {
        expect(declared, `${k} runs locally and must NOT be listed`).not.toContain(`llm:${k}`);
      }
    }
  });

  it("every third-party credential resolves to a declaration", async () => {
    // The anti-drift rule. Adding an integration means adding a credential,
    // and this makes that the moment the disclosure has to be updated —
    // rather than whenever someone next remembers the page exists.
    const { SUBPROCESSORS, FIRST_PARTY_SECRETS, DECLARED_BUT_UNUSED } = await import("@ai-company-os/core");
    const covered = new Set(SUBPROCESSORS.flatMap((s) => s.envPrefixes));

    const unexplained = credentialVars().filter((v) => {
      if (Object.prototype.hasOwnProperty.call(FIRST_PARTY_SECRETS, v)) return false;
      if (Object.prototype.hasOwnProperty.call(DECLARED_BUT_UNUSED, v)) return false;
      return ![...covered].some((p) => v.startsWith(p));
    });
    expect(
      unexplained,
      `credentials with no subprocessor and no first-party reason: ${unexplained.join(", ")}`,
    ).toEqual([]);
  });

  it("refuses an exemption with no reason, in either register", async () => {
    const { FIRST_PARTY_SECRETS, DECLARED_BUT_UNUSED } = await import("@ai-company-os/core");
    for (const [name, why] of Object.entries({ ...FIRST_PARTY_SECRETS, ...DECLARED_BUT_UNUSED })) {
      expect(typeof why === "string" && why.trim().length > 10, `${name} needs a real reason`).toBe(true);
    }
  });

  it("keeps 'declared but unused' honest — nothing in it may actually be read", async () => {
    // The category only means something if membership is checked. A variable
    // that gets wired up later must fall out of it and force a subprocessor
    // declaration, rather than sitting here labelled harmless.
    const { DECLARED_BUT_UNUSED } = await import("@ai-company-os/core");
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "__tests__") continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!/\.ts$/.test(e.name) || /\.(test|spec)\.ts$/.test(e.name)) continue;
        const text = readFileSync(abs, "utf8");
        for (const name of Object.keys(DECLARED_BUT_UNUSED)) {
          if (text.includes(name)) readers.push(`${name} is read in ${abs.slice(API_SRC.length + 1)}`);
        }
      }
    };
    walk(API_SRC);
    expect(readers, readers.join("\n")).toEqual([]);
  });

  it("pins the fixed processors, so trimming one is a decision", async () => {
    // The derived half cannot be forgotten; the hand-written half can. Pinned
    // exactly, like the mount-order gate — a count that only ever floors
    // would let an entry be dropped while its credential quietly remains
    // covered by another entry's prefix list.
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    const infra = SUBPROCESSORS.filter((s) => !s.id.startsWith("llm")).map((s) => s.id).sort();
    expect(infra).toEqual(
      [
        "apple", "aws-lightsail", "aws-s3", "cloudflare", "expo", "github", "google",
        "google-fonts", "hubspot", "plausible", "revenuecat", "sendgrid", "sentry",
        "stripe", "vapi", "web-search",
      ].sort(),
    );
  });

  it("does not claim a destination it cannot know", async () => {
    // The customer supplies the key and picks the vendor, so where their
    // prompts land is their choice. Naming a region here would be a guess
    // presented to a data subject as a fact.
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    for (const s of SUBPROCESSORS.filter((x) => x.customerControlled)) {
      expect(s.transferRegion, `${s.id} must not assert a region`).toBe("customer-chosen");
    }
  });

  it("states purpose, data and transfer for every entry — a name alone discloses nothing", async () => {
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    expect(SUBPROCESSORS.length).toBeGreaterThan(10);
    for (const s of SUBPROCESSORS) {
      expect(s.name.length, `${s.id} needs a name`).toBeGreaterThan(1);
      expect(s.purpose.length, `${s.id} needs a purpose`).toBeGreaterThan(15);
      expect(s.dataCategories.length, `${s.id} must say WHAT data`).toBeGreaterThan(0);
      expect(["EEA", "UK", "US", "global", "customer-chosen"]).toContain(s.transferRegion);
    }
  });

  it("does not invent a vendor the code never contacts", async () => {
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    const { PROVIDER_INFO } = await import("../../services/ai-client");
    const knownProviders = new Set(Object.keys(PROVIDER_INFO));
    for (const s of SUBPROCESSORS) {
      if (!s.id.startsWith("llm")) continue;
      expect(knownProviders, `${s.id} is not a provider this code knows`).toContain(s.id.split(":")[1]);
    }
  });
});

describe("a vendor we FUND is not a vendor the customer chose", () => {
  it("no customer-controlled entry may rest on a key from our own environment", async () => {
    // The laundering hole. `GROQ_API_KEY` is OUR key, but it satisfied the
    // anti-drift rule by prefix-matching the `llm:GROQ` entry, which was
    // flagged customerControlled — so the disclosure told a free-tier user
    // that OUR routing decision was theirs. The rule could not tell "the
    // customer's key" from "our key with the same name".
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    const ourVars = new Set(
      [...ENV_SRC.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]),
    );
    for (const s of SUBPROCESSORS.filter((x) => x.customerControlled)) {
      for (const prefix of s.envPrefixes) {
        const ours = [...ourVars].some((v) => v.startsWith(prefix));
        expect(
          ours,
          `${s.id} claims ${prefix}, which WE declare — so it is not customer-chosen`,
        ).toBe(false);
      }
    }
  });

  it("marks the trial and fallback vendors as ours, with a real region", async () => {
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    const funded = SUBPROCESSORS.filter((s) => s.systemFunded);
    // Groq (trial pool), Cerebras + Zhipu (onboarding), Anthropic (fallback).
    expect(funded.length).toBe(4);
    for (const s of funded) {
      expect(s.customerControlled, `${s.id} cannot be both`).not.toBe(true);
      expect(s.transferRegion, `${s.id} must name a real region`).not.toBe("customer-chosen");
    }
  });

  it("declares the recipient that needs no credential at all", async () => {
    // Expo push takes no key, so the credential rule was structurally blind
    // to it — while this same change withholds `pushToken` from the export as
    // "a live credential". The code knew it was sensitive; the disclosure did
    // not say who receives it. Anchored to the endpoint in the source, so
    // deleting the entry while the code still POSTs there fails.
    const push = readFileSync(join(__dirname, "..", "..", "services", "push.ts"), "utf8");
    const host = push.match(/https:\/\/([a-z0-9.-]+)/)?.[1];
    expect(host, "push.ts no longer names an endpoint — re-check this gate").toBeTruthy();
    // Anchored to the HOST, not merely to the entry existing. Asserting
    // "expo is declared" would keep passing after push.ts was repointed at a
    // different vendor — the anchor would then bless a swap.
    const { SUBPROCESSORS } = await import("@ai-company-os/core");
    const byHost: Record<string, string> = { "exp.host": "expo" };
    const expected = byHost[host!];
    expect(
      expected,
      `push.ts posts to ${host}, which this gate does not know — map it to a subprocessor`,
    ).toBeTruthy();
    expect(
      SUBPROCESSORS.some((s) => s.id === expected),
      `push notifications go to ${host}; ${expected} must be disclosed`,
    ).toBe(true);
  });
});

describe("credentials cannot hide outside the schema", () => {
  it("forbids reading a secret straight from process.env", async () => {
    // The class behind four separate misses. `config/env.ts` is the declared
    // surface the disclosure gate reads; a module that reaches into
    // `process.env.TAVILY_API_KEY` bypasses it entirely, and
    // `process.env[`${provider}_API_KEY`]` cannot be enumerated by any static
    // scan at all. Declaring it in env.ts is what makes it visible.
    const { FIRST_PARTY_SECRETS, SUBPROCESSORS } = await import("@ai-company-os/core");
    const declaredNames = new Set<string>([
      ...[...ENV_SRC.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]),
      ...Object.keys(FIRST_PARTY_SECRETS),
    ]);
    // A name covered by a declared subprocessor prefix is visible too.
    const prefixes = SUBPROCESSORS.flatMap((s) => s.envPrefixes);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "__tests__") continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!/\.ts$/.test(e.name) || /\.(test|spec)\.ts$/.test(e.name)) continue;
        if (abs.endsWith(join("config", "env.ts"))) continue;
        const text = readFileSync(abs, "utf8");
        text.split("\n").forEach((line, i) => {
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
          const m = line.match(/process\.env\s*\.\s*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET))/);
          if (!m) return;
          // Allowed only if the name is ACCOUNTED FOR — declared in the env
          // schema, or registered as first-party. The point is not to ban
          // process.env; it is that no credential may be invisible to the
          // disclosure gate.
          const name = m[1];
          if (declaredNames.has(name) || prefixes.some((p) => p && name.startsWith(p))) return;
          offenders.push(`${abs.slice(API_SRC.length + 1)}:${i + 1} ${line.trim()}`);
        });
      }
    };
    walk(API_SRC);
    expect(
      offenders,
      `secrets read outside config/env.ts, so the disclosure gate cannot see them:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
