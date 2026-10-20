/** A tab-local, owner-bound draft. Preparing it never starts inference or creates a company. */
export const ONBOARDING_HANDOFF_KEY = "braavo-onboarding-builder-v1";
const MAX_AGE_MS = 15 * 60_000;
type Owner = { tenantId: string | null; revision: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export function onboardingDescription(input: {
  description: string; companyName: string; niche: string; targetAudience: string;
  selectedIndustry: string | null; selectedUseCases: string[]; selectedPrimitives: string[];
}): string {
  return [
    input.description.trim(),
    input.companyName.trim() && `Workspace name: ${input.companyName.trim()}`,
    input.niche.trim() && `Niche: ${input.niche.trim()}`,
    input.targetAudience.trim() && `Target audience: ${input.targetAudience.trim()}`,
    input.selectedIndustry && `Industry: ${input.selectedIndustry}`,
    input.selectedUseCases.length && `Requested use cases: ${input.selectedUseCases.join("; ")}`,
    input.selectedPrimitives.length && `Requested primitives: ${input.selectedPrimitives.join(", ")}`,
  ].filter(Boolean).join("\n\n");
}

export function saveOnboardingHandoff(storage: Storage, owner: Owner, description: string, now = Date.now()): void {
  if (!owner.tenantId || !description.trim()) throw new Error("Invalid onboarding draft owner or description");
  storage.setItem(ONBOARDING_HANDOFF_KEY, JSON.stringify({ tenantId: owner.tenantId, revision: owner.revision, description, createdAt: now }));
}

export function consumeOnboardingHandoff(storage: Storage, owner: Owner, now = Date.now()): string | null {
  const raw = storage.getItem(ONBOARDING_HANDOFF_KEY);
  if (!raw) return null;
  // One read consumes even a malformed, stale or foreign-owner value.
  storage.removeItem(ONBOARDING_HANDOFF_KEY);
  try {
    const draft = JSON.parse(raw);
    if (!owner.tenantId || draft.tenantId !== owner.tenantId || draft.revision !== owner.revision
      || typeof draft.createdAt !== "number" || now < draft.createdAt || now - draft.createdAt > MAX_AGE_MS
      || typeof draft.description !== "string" || !draft.description.trim()) return null;
    return draft.description;
  } catch { return null; }
}
