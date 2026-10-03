import type { GoogleAncestorResolver } from "./google";
type OwnershipAlias = {
    tokenDigest: string;
    state: string;
    tenantId: string | null;
    mobileSubscriptionId: string | null;
    provider: string | null;
    canonicalRootIdentity: string | null;
    lineageState?: string;
    lineagePredecessorDigest?: string | null;
    lineageVerifiedAt?: Date | null;
    lineageEvidenceSource?: string | null;
};
export interface GoogleAncestryStore {
    findMany(args: {
        where: {
            tokenDigest: {
                in: string[];
            };
            tenantId?: string;
        };
    }): Promise<OwnershipAlias[]>;
}
const DIGEST = /^google:[0-9a-f]{64}$/;
/**
 * A persisted alias is evidence of identity, never of current paid status.
 * Tenant-bound requests also filter explicitly; system RTDN may locate an
 * existing owner, but the subsequent ownership transaction must lock and
 * revalidate that owner and all aliases before any entitlement effect.
 */
export function knownGoogleAncestorResolver(store: GoogleAncestryStore, tenantId?: string, directed = false): GoogleAncestorResolver {
    return async (tokenDigest) => {
        if (!DIGEST.test(tokenDigest))
            return null;
        const where = (digest: string) => ({
            tokenDigest: { in: [digest] },
            ...(tenantId === undefined ? {} : { tenantId }),
        });
        const aliases = await store.findMany({ where: where(tokenDigest) });
        const alias = aliases[0]!;
        if (aliases.length !== 1
            || alias.tokenDigest !== tokenDigest
            || alias.state !== "active"
            || alias.provider !== "google"
            || !alias.tenantId
            || !alias.mobileSubscriptionId
            || !DIGEST.test(alias.canonicalRootIdentity ?? "")
            || (tenantId !== undefined && alias.tenantId !== tenantId))
            return null;
        const rootIdentity = alias.canonicalRootIdentity!;
        const roots = rootIdentity === tokenDigest
            ? aliases
            : await store.findMany({ where: where(rootIdentity) });
        const root = roots[0]!;
        if (roots.length !== 1
            || root.tokenDigest !== rootIdentity
            || root.state !== "active"
            || root.provider !== "google"
            || root.tenantId !== alias.tenantId
            || root.mobileSubscriptionId !== alias.mobileSubscriptionId
            || root.canonicalRootIdentity !== rootIdentity)
            return null;
        if (!directed)
            return { canonicalRootIdentity: rootIdentity };
        const suffix: string[] = [];
        let current = alias;
        for (let depth = 0; depth < 8; depth++) {
            if (suffix.includes(current.tokenDigest))
                return null;
            suffix.push(current.tokenDigest);
            if ((current.lineageState ?? "unknown") === "unknown") {
                if (current.lineagePredecessorDigest != null || current.lineageVerifiedAt != null || current.lineageEvidenceSource != null)
                    return null;
                return { canonicalRootIdentity: rootIdentity, aliases: suffix.at(-1) === rootIdentity ? suffix : [...suffix, rootIdentity], complete: false };
            }
            if (!(current.lineageVerifiedAt instanceof Date) || !Number.isFinite(current.lineageVerifiedAt.getTime()) || current.lineageEvidenceSource !== "play-subscriptionsv2-v1")
                return null;
            if (current.lineageState === "root") {
                if (current.tokenDigest !== rootIdentity || current.lineagePredecessorDigest !== null)
                    return null;
                return { canonicalRootIdentity: rootIdentity, aliases: suffix, complete: true };
            }
            const previous = current.lineagePredecessorDigest;
            if (current.lineageState !== "edge" || !DIGEST.test(previous ?? "") || previous === current.tokenDigest || suffix.includes(previous!))
                return null;
            const matches = previous === rootIdentity ? roots : await store.findMany({ where: where(previous!) });
            if (matches.length !== 1)
                return { canonicalRootIdentity: rootIdentity, aliases: [tokenDigest, rootIdentity].filter((x, i, a) => a.indexOf(x) === i), complete: false };
            const next = matches[0]!;
            if (next.tokenDigest !== previous || next.state !== "active" || next.provider !== "google" || next.tenantId !== alias.tenantId || next.mobileSubscriptionId !== alias.mobileSubscriptionId || next.canonicalRootIdentity !== rootIdentity)
                return null;
            current = next;
        }
        return null;
    };
}
