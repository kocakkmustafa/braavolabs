type DraftForActions = { companyId?: string; status?: string; type?: string } | null;
type CompanyForActions = { id?: string; status?: string } | null;

export function draftActions(draft: DraftForActions, company: CompanyForActions) {
  const belongsToSelectedCompany = !!draft && !!company && draft.companyId === company.id;
  const pending = belongsToSelectedCompany && draft?.status === "PENDING";
  const active = company?.status === "ACTIVE";
  return {
    approve: pending && active,
    send: pending && active && draft?.type === "EMAIL",
    reject: pending,
  };
}

/** Display authored text, never the complete JSON (which can include recipients and private metadata). */
export function previewDraftContent(value: unknown): string | null {
  const content = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const candidate = typeof value === "string"
    ? value
    : content?.body ?? content?.text ?? content?.message;
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const body = candidate.trim().slice(0, 10_000);
  const hashtags = Array.isArray(content?.hashtags)
    ? content.hashtags
      .filter((tag): tag is string => typeof tag === "string" && !!tag.trim())
      .slice(0, 50)
      .map((tag) => tag.trim().startsWith("#") ? tag.trim() : `#${tag.trim()}`)
    : [];
  return hashtags.length > 0 ? `${body}\n\n${hashtags.join(" ")}` : body;
}
