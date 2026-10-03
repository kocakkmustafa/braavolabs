export type InternalPaidPlan = "CREATOR" | "PRO" | "BUSINESS" | "ENTERPRISE";
export type MobilePublicTier = "INDIVIDUAL" | "TEAM";
export type IapSaleClass = "new-sale" | "restore-only" | "manual-review";

export type IapProduct = Readonly<{
  internalPlan: InternalPaidPlan;
  publicTier: MobilePublicTier | null;
  sale: IapSaleClass;
}>;

function product(
  internalPlan: InternalPaidPlan,
  publicTier: MobilePublicTier | null,
  sale: IapSaleClass,
): IapProduct {
  return Object.freeze({ internalPlan, publicTier, sale });
}

/**
 * Single server-side authority for every Apple/Google subscription product.
 *
 * Internal plans remain the Prisma/entitlement vocabulary. Public tiers are
 * the canonical names understood by the mobile purchase flow. Historical
 * products stay verifiable for restore. Individual is the only new-sale row;
 * Team and safely mapped historical aliases remain restore-only.
 */
const IAP_PRODUCT_CATALOG: Readonly<Record<string, IapProduct>> = Object.freeze({
  "com.braavolabs.individual.monthly": product("CREATOR", "INDIVIDUAL", "new-sale"),
  "com.braavolabs.team.monthly": product("PRO", "TEAM", "restore-only"),
  "com.braavolabs.team.yearly": product("PRO", "TEAM", "restore-only"),

  "com.braavolabs.creator.monthly": product("CREATOR", "INDIVIDUAL", "restore-only"),
  "com.braavolabs.creator.yearly": product("CREATOR", "INDIVIDUAL", "restore-only"),
  "com.braavolabs.pro.monthly": product("PRO", "TEAM", "restore-only"),
  "com.braavolabs.pro.yearly": product("PRO", "TEAM", "restore-only"),

  "com.braavolabs.business.monthly": product("BUSINESS", null, "manual-review"),
  "com.braavolabs.business.yearly": product("BUSINESS", null, "manual-review"),
  "com.braavolabs.enterprise.monthly": product("ENTERPRISE", null, "manual-review"),
  "com.braavolabs.enterprise.yearly": product("ENTERPRISE", null, "manual-review"),
});

export function getIapProduct(productId: string): IapProduct | undefined {
  return Object.prototype.hasOwnProperty.call(IAP_PRODUCT_CATALOG, productId)
    ? IAP_PRODUCT_CATALOG[productId]
    : undefined;
}

export function internalPlanForProduct(productId: string): InternalPaidPlan | undefined {
  return getIapProduct(productId)?.internalPlan;
}

export function isNewSaleProduct(productId: string): boolean {
  return getIapProduct(productId)?.sale === "new-sale";
}

export function verificationResponseTier(
  catalogProduct: IapProduct,
): MobilePublicTier | null {
  return catalogProduct.publicTier;
}
