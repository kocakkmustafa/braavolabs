import { AppError } from "../../../middleware/error";
export interface GoogleLineageObservation {
    tokenDigest: string;
    state: "root" | "edge";
    predecessorDigest: string | null;
}
export interface GoogleLineageAlias {
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
}
export interface GoogleLineageStore {
    findMany(args: {
        where: {
            tokenDigest: {
                in: string[];
            };
            tenantId?: string;
        };
    }): Promise<GoogleLineageAlias[]>;
    updateMany(args: {
        where: Record<string, string | null>;
        data: {
            lineageState: "root" | "edge";
            lineagePredecessorDigest: string | null;
            lineageVerifiedAt: Date;
            lineageEvidenceSource: string;
        };
    }): Promise<{
        count: number;
    }>;
}
export interface GoogleLineageFence {
    tenantId: string;
    subscriptionId: string;
    rootIdentity: string;
    aliases: string[];
}
const DIGEST = /^google:[0-9a-f]{64}$/;
const conflict = () => new AppError(409, "Google purchase lineage conflicts with verified evidence");
function validFence(f: GoogleLineageFence): void {
    if (!f.tenantId || !f.subscriptionId || !DIGEST.test(f.rootIdentity)
        || !f.aliases.length || f.aliases.length > 8 || new Set(f.aliases).size !== f.aliases.length
        || f.aliases.some(x => !DIGEST.test(x)) || f.aliases.at(-1) !== f.rootIdentity)
        throw conflict();
}
function matches(row: GoogleLineageAlias, f: GoogleLineageFence): boolean {
    return row.state === "active" && row.tenantId === f.tenantId && row.mobileSubscriptionId === f.subscriptionId
        && row.provider === "google" && row.canonicalRootIdentity === f.rootIdentity;
}
function metadata(row: GoogleLineageAlias): "unknown" | "root" | "edge" {
    const state = row.lineageState ?? "unknown";
    if (state === "unknown") {
        if (row.lineagePredecessorDigest != null || row.lineageVerifiedAt != null || row.lineageEvidenceSource != null)
            throw conflict();
        return state;
    }
    if (!(row.lineageVerifiedAt instanceof Date) || !Number.isFinite(row.lineageVerifiedAt.getTime()) || row.lineageEvidenceSource !== "play-subscriptionsv2-v1")
        throw conflict();
    if (state === "root" && row.lineagePredecessorDigest === null && row.tokenDigest === row.canonicalRootIdentity)
        return state;
    if (state === "edge" && DIGEST.test(row.lineagePredecessorDigest ?? "") && row.lineagePredecessorDigest !== row.tokenDigest)
        return state;
    throw conflict();
}
async function rowsFor(store: Pick<GoogleLineageStore, "findMany">, f: GoogleLineageFence) {
    const rows = await store.findMany({ where: { tokenDigest: { in: f.aliases }, tenantId: f.tenantId } });
    if (rows.some(r => !f.aliases.includes(r.tokenDigest) || !matches(r, f)) || new Set(rows.map(r => r.tokenDigest)).size !== rows.length)
        throw conflict();
    return new Map(rows.map(r => [r.tokenDigest, r]));
}
/** Caller holds the same-owner subscription lock; no ownership is created here. */
export async function persistGoogleLineage(store: GoogleLineageStore, input: GoogleLineageFence & {
    observations: GoogleLineageObservation[];
    readComplete: Date;
}): Promise<void> {
    validFence(input);
    if (!(input.readComplete instanceof Date) || !Number.isFinite(input.readComplete.getTime()) || new Set(input.observations.map(o => o.tokenDigest)).size !== input.observations.length)
        throw conflict();
    const rows = await rowsFor(store, input);
    if (rows.size !== input.aliases.length)
        throw conflict();
    for (const o of input.observations) {
        if (!input.aliases.includes(o.tokenDigest) || (o.state !== "root" && o.state !== "edge")
            || (o.state === "root" ? o.predecessorDigest !== null || o.tokenDigest !== input.rootIdentity
                : !DIGEST.test(o.predecessorDigest ?? "") || o.predecessorDigest === o.tokenDigest || !input.aliases.includes(o.predecessorDigest!)))
            throw conflict();
        const row = rows.get(o.tokenDigest)!;
        const state = metadata(row);
        if (state !== "unknown") {
            if (state !== o.state || row.lineagePredecessorDigest !== o.predecessorDigest)
                throw conflict();
            continue;
        }
        const updated = await store.updateMany({ where: { tokenDigest: o.tokenDigest, tenantId: input.tenantId, mobileSubscriptionId: input.subscriptionId, provider: "google", canonicalRootIdentity: input.rootIdentity, state: "active", lineageState: "unknown", lineagePredecessorDigest: null, lineageVerifiedAt: null, lineageEvidenceSource: null }, data: { lineageState: o.state, lineagePredecessorDigest: o.predecessorDigest, lineageVerifiedAt: input.readComplete, lineageEvidenceSource: "play-subscriptionsv2-v1" } });
        if (updated.count !== 1)
            throw conflict();
    }
    const after = await rowsFor(store, input);
    if (after.size !== input.aliases.length)
        throw conflict();
    for (const o of input.observations) {
        const row = after.get(o.tokenDigest)!;
        if (metadata(row) !== o.state || row.lineagePredecessorDigest !== o.predecessorDigest)
            throw conflict();
    }
}
/** Revalidate the exact directed chain under the owner's lock before any effect. */
export async function assertGoogleLineage(store: Pick<GoogleLineageStore, "findMany">, f: GoogleLineageFence): Promise<boolean> {
    validFence(f);
    const rows = await rowsFor(store, f);
    let incomplete = rows.size !== f.aliases.length;
    for (let i = 0; i < f.aliases.length; i++) {
        const row = rows.get(f.aliases[i]!);
        if (!row)
            continue;
        const state = metadata(row);
        if (state === "unknown") {
            incomplete = true;
            continue;
        }
        if (i === f.aliases.length - 1 ? state !== "root" : state !== "edge" || row.lineagePredecessorDigest !== f.aliases[i + 1])
            throw conflict();
    }
    return !incomplete;
}
/** Adapter until the additive draft migration has a generated client. */
export function googleLineageStore(store: unknown): GoogleLineageStore { return store as GoogleLineageStore; }
