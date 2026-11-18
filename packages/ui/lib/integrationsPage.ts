import { buildCatalog, type CatalogEntry, type IntegrationRow, type ProviderInfo } from "./integrationsCatalog";

export type Company = { id: string; name: string };

export type PageState = {
  providers: ProviderInfo[] | null;
  providersFailed: boolean;
  companies: Company[] | null;
  companiesFailed: boolean;
  companyId: string;
  integrations: IntegrationRow[] | null;
  statusFailed: boolean;
};

export const initialState: PageState = {
  providers: null, providersFailed: false, companies: null, companiesFailed: false,
  companyId: "", integrations: null, statusFailed: false,
};

export type Action =
  | { type: "reload" }
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "providersFailed" }
  | { type: "companies"; companies: Company[] }
  | { type: "companiesFailed" }
  | { type: "selectCompany"; companyId: string }
  | { type: "status"; companyId: string; rows: IntegrationRow[] }
  | { type: "statusFailed"; companyId: string };

export function reducer(s: PageState, a: Action): PageState {
  switch (a.type) {
    case "reload":
      return { ...s, providersFailed: false, companiesFailed: false, statusFailed: false, integrations: null };
    case "providers":
      return { ...s, providers: a.providers, providersFailed: false };
    case "providersFailed":
      return { ...s, providersFailed: true };
    case "companies": {
      const keep = a.companies.some((c) => c.id === s.companyId);
      return { ...s, companies: a.companies, companiesFailed: false, companyId: keep ? s.companyId : a.companies[0]?.id ?? "" };
    }
    case "companiesFailed":
      return { ...s, companiesFailed: true };
    case "selectCompany":
      return a.companyId === s.companyId ? s : { ...s, companyId: a.companyId, integrations: null, statusFailed: false };
    // Responses for a company that is no longer selected are ignored.
    case "status":
      return a.companyId === s.companyId ? { ...s, integrations: a.rows, statusFailed: false } : s;
    case "statusFailed":
      return a.companyId === s.companyId ? { ...s, statusFailed: true } : s;
  }
}

export type View = "loading" | "providersError" | "companiesError" | "noCompany" | "empty" | "ready";

export function viewOf(s: PageState): View {
  if (s.providersFailed) return "providersError";
  if (s.providers === null) return "loading";
  if (s.companiesFailed) return "companiesError";
  if (s.companies === null) return "loading";
  if (s.providers.length === 0) return "empty";
  if (s.companies.length === 0) return "noCompany";
  return "ready";
}

// No status call is made without a company; a failed status call yields "unknown" cards.
export function entriesOf(s: PageState): CatalogEntry[] {
  return buildCatalog(s.providers ?? [], s.integrations);
}
