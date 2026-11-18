// Integrations page data model. The catalog is built ONLY from the API:
// /integrations/providers (what can really be connected) joined with
// /integrations/:companyId (connection state). Nothing is invented here.

export type ProviderInfo = {
  provider: string;
  name: string;
  description?: string;
  docsUrl?: string;
  fields?: Array<{ key: string; label: string }>;
};

export type IntegrationRow = {
  provider: string;
  status?: string;
  lastTestedAt?: string | null;
};

export type ConnectionState = "connected" | "pending" | "error" | "expired" | "none" | "unknown";

export type CatalogEntry = {
  provider: string;
  name: string;
  description: string;
  docsUrl: string | null;
  fieldCount: number;
  state: ConnectionState;
  lastTestedAt: string | null;
};

export function connectionState(status: string | undefined): ConnectionState {
  if (status === "ACTIVE") return "connected";
  if (status === "PENDING") return "pending";
  if (status === "ERROR") return "error";
  if (status === "EXPIRED") return "expired";
  return "none";
}

// `integrations === null` means the status request failed or has no
// workspace yet: states are "unknown", never a guessed "not connected".
export function buildCatalog(providers: ProviderInfo[], integrations: IntegrationRow[] | null): CatalogEntry[] {
  const byProvider = new Map<string, IntegrationRow>();
  for (const row of integrations ?? []) byProvider.set(row.provider, row);
  return providers
    .filter((p) => p && typeof p.provider === "string" && p.provider.length > 0)
    .map((p) => {
      const row = byProvider.get(p.provider);
      return {
        provider: p.provider,
        name: p.name || p.provider,
        description: p.description ?? "",
        docsUrl: p.docsUrl && /^https:\/\//.test(p.docsUrl) ? p.docsUrl : null,
        fieldCount: p.fields?.length ?? 0,
        state: integrations === null ? "unknown" : connectionState(row?.status),
        lastTestedAt: row?.lastTestedAt ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function filterCatalog(entries: CatalogEntry[], search: string): CatalogEntry[] {
  const q = search.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
}

export function countByState(entries: CatalogEntry[]): Record<ConnectionState, number> {
  const out: Record<ConnectionState, number> = { connected: 0, pending: 0, error: 0, expired: 0, none: 0, unknown: 0 };
  for (const e of entries) out[e.state] += 1;
  return out;
}
