/**
 * Takeover config resolution (E3/T6 — plan §2.5). Turns a CLAIMED
 * handoff_ledger row into a ready-to-dial AIClientConfig the resume leg feeds
 * to runAgentLoop's aiConfigOverride path (which, being an override, skips the
 * tenant chain / trial resolution entirely — E2/T5 D-010). One resolver, two
 * shapes:
 *
 *   • keyless-local target (OLLAMA / LMSTUDIO / CUSTOM) → apiKey "", baseUrl
 *     from the claim (persisted onto the checkpoint as `claimBaseUrl` at
 *     claim-time, T5). PROD keyless-local WITHOUT a baseUrl is REJECTED — the
 *     PROVIDER_BASE_URLS localhost default points at Lightsail's OWN loopback
 *     and would break the orchestration-only invariant (B4c). Defence in depth:
 *     the /continue endpoint already blocks this at claim time via
 *     assertValidTakeoverTarget — this resolver enforces the SAME rule so the
 *     approval-decide path and any future claim site can't bypass it.
 *
 *   • cloud target → the tenant's configured BYOK link for toProvider, key
 *     decrypted (reuses listTenantProviderLinks, i.e. provider-chain's rowToLink
 *     decrypt path — no second decrypt implementation). A cloud target that is
 *     no longer configured (the row was deleted between claim and resume) is a
 *     hard error: we will NOT silently fall back to another provider or the
 *     system wallet.
 *
 * The model on the returned config is the ledger's toModel resolved through the
 * §2.4 hierarchy against the TAKEOVER provider (an Anthropic model name must not
 * reach Ollama and 400 — same guard the failover switch applies, claude.ts).
 */

import type { HandoffLedger } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import {
  LOCAL_PROVIDERS,
  resolveModelForProvider,
  type AIClientConfig,
  type AIProviderType,
} from "./ai-client";
import { listTenantProviderLinks } from "./provider-chain";

/**
 * Prod keyless-local baseUrl guard (§2.5 — B4c). The SINGLE source of truth for
 * the rule; the /continue endpoint's assertValidTakeoverTarget imports this so
 * both the claim boundary and the resume boundary enforce it identically.
 *
 * In production (and not OFFLINE_MODE) a keyless-local takeover MUST carry an
 * explicit baseUrl — the localhost default is Lightsail's own loopback. Only
 * local dev / OFFLINE_MODE may fall back to the default endpoint.
 *
 * Throws Error on violation; returns nothing on success. Cloud providers are a
 * no-op here (they dial their own default endpoint).
 */
export function assertKeylessLocalBaseUrl(
  provider: AIProviderType,
  baseUrl: string | undefined,
): void {
  if (!LOCAL_PROVIDERS.has(provider)) return;
  const prodLike = env.NODE_ENV === "production" && env.OFFLINE_MODE !== true;
  if (prodLike && (!baseUrl || !baseUrl.trim())) {
    throw new Error(
      `Keyless-local takeover to ${provider} requires an explicit base URL in production ` +
        `(the server won't fall back to its own localhost).`,
    );
  }
}

/** The claim-time baseUrl annotation the T5 claim writes onto the ledger's
 * checkpoint JSON (`claimBaseUrl`). The ledger has no dedicated column
 * (single-migration invariant), so it rides on the checkpoint. */
function readClaimBaseUrl(checkpoint: unknown): string | undefined {
  if (checkpoint && typeof checkpoint === "object") {
    const raw = (checkpoint as { claimBaseUrl?: unknown }).claimBaseUrl;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return undefined;
}

/**
 * Resolve the AIClientConfig for a CLAIMED handoff. The ledger must already be
 * CLAIMED (toProvider/toModel set); callers that hold an OPEN ledger have no
 * takeover target yet.
 *
 * @throws when the ledger isn't claimed, when a cloud target is no longer a
 *   configured BYOK link, or when a prod keyless-local target lacks a baseUrl.
 */
export async function resolveTakeoverConfig(ledger: HandoffLedger): Promise<AIClientConfig> {
  if (!ledger.toProvider || !ledger.toModel) {
    throw new Error(
      `resolveTakeoverConfig: handoff ${ledger.id} has no takeover target (status=${ledger.status}).`,
    );
  }
  const provider = ledger.toProvider as AIProviderType;
  const isLocal = LOCAL_PROVIDERS.has(provider);

  if (isLocal) {
    // Keyless-local: baseUrl comes from the claim (§2.5/T5). Enforce the prod
    // rule here too (B4c) — never dial Lightsail's own localhost in prod.
    const baseUrl = readClaimBaseUrl(ledger.checkpoint);
    assertKeylessLocalBaseUrl(provider, baseUrl);
    // Resolve the model against the takeover provider (§2.4) — a cloud model
    // name carried over from the leaving provider must not reach a local one.
    const model = resolveModelForProvider(provider, ledger.toModel, undefined);
    return { provider, model, apiKey: "", ...(baseUrl ? { baseUrl } : {}) };
  }

  // Cloud target: reuse the tenant's decrypted BYOK link for this provider
  // (listTenantProviderLinks → provider-chain rowToLink decrypt path). NO
  // silent fallback: a target that vanished between claim and resume is a hard
  // error, not a system-wallet detour.
  const links = await listTenantProviderLinks(ledger.tenantId);
  const link = links.find((l) => l.provider === provider);
  if (!link) {
    logger.warn(
      { handoffId: ledger.id, tenantId: ledger.tenantId, provider },
      "resolveTakeoverConfig: claimed cloud provider is no longer a configured BYOK link",
    );
    throw new Error(
      `Takeover provider ${provider} is no longer configured for this workspace — re-open the handoff and pick another provider.`,
    );
  }
  const model = resolveModelForProvider(provider, ledger.toModel, link.config.model);
  return { ...link.config, model };
}
