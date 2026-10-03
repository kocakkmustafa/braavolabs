import type { GoogleAncestorResolver } from "./google";

type OwnershipAlias = {
  tokenDigest: string;
  state: string;
  tenantId: string | null;
  mobileSubscriptionId: string | null;
  provider: string | null;
  canonicalRootIdentity: string | null;
};

export interface GoogleAncestryStore {
  findMany(args: {
    where: { tokenDigest: { in: string[] }; tenantId?: string };
  }): Promise<OwnershipAlias[]>;
}

const DIGEST = /^google:[0-9a-f]{64}$/;

/**
 * A persisted alias is evidence of identity, never of current paid status.
 * Tenant-bound requests also filter explicitly; system RTDN may locate an
 * existing owner, but the subsequent ownership transaction must lock and
 * revalidate that owner and all aliases before any entitlement effect.
 */
export function knownGoogleAncestorResolver(
  store: GoogleAncestryStore,
  tenantId?: string,
): GoogleAncestorResolver {
  return async (tokenDigest) => {
    if (!DIGEST.test(tokenDigest)) return null;
    const where = (digest: string) => ({
      tokenDigest: { in: [digest] },
      ...(tenantId === undefined ? {} : { tenantId }),
    });
    const aliases = await store.findMany({ where: where(tokenDigest) });
    const alias = aliases[0]!;
    if (
      aliases.length !== 1
      || alias.tokenDigest !== tokenDigest
      || alias.state !== "active"
      || alias.provider !== "google"
      || !alias.tenantId
      || !alias.mobileSubscriptionId
      || !DIGEST.test(alias.canonicalRootIdentity ?? "")
      || (tenantId !== undefined && alias.tenantId !== tenantId)
    ) return null;

    const rootIdentity = alias.canonicalRootIdentity!;
    const roots = rootIdentity === tokenDigest
      ? aliases
      : await store.findMany({ where: where(rootIdentity) });
    const root = roots[0]!;
    if (
      roots.length !== 1
      || root.tokenDigest !== rootIdentity
      || root.state !== "active"
      || root.provider !== "google"
      || root.tenantId !== alias.tenantId
      || root.mobileSubscriptionId !== alias.mobileSubscriptionId
      || root.canonicalRootIdentity !== rootIdentity
    ) return null;

    return { canonicalRootIdentity: rootIdentity };
  };
}
