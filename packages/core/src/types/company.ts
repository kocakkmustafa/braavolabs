export type Primitive =
  | "ACQUISITION"
  | "SALES"
  | "DELIVERY"
  | "CONTENT"
  | "OPERATIONS"
  | "FINANCE"
  | "ANALYTICS"
  | "MEMORY"
  | "GOVERNANCE";

export type CompanyStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";

export interface CompanyConfig {
  channels?: string[];
  contentTypes?: string[];
  postingFrequency?: string;
  [key: string]: unknown;
}

export interface CreateCompanyInput {
  name: string;
  slug: string;
  description?: string;
  primitives: Primitive[];
  config?: CompanyConfig;
}

export interface UpdateCompanyInput {
  name?: string;
  description?: string;
  primitives?: Primitive[];
  config?: CompanyConfig;
  status?: CompanyStatus;
}
