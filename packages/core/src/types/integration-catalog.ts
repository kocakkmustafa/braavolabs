// ─── Integration Catalog Types ───────────────────────────────────────────────

export interface IntegrationConnector {
  id: string;
  name: string;
  description: string;
  category: IntegrationCategory;
  icon: string; // emoji
  status: "available" | "coming_soon" | "beta";
  authType: "oauth2" | "api_key" | "webhook" | "basic_auth";
  docsUrl?: string;
  features: string[];
  popularActions: string[];
}

export type IntegrationCategory =
  | "crm"
  | "social_media"
  | "email_marketing"
  | "messaging"
  | "productivity"
  | "ecommerce"
  | "dev_tools"
  | "analytics"
  | "advertising"
  | "payment"
  | "storage"
  | "ai_ml"
  | "customer_support"
  | "hr"
  | "project_management"
  | "design"
  | "video"
  | "forms"
  | "scheduling"
  | "automation";

export interface IntegrationCatalogFilter {
  category?: IntegrationCategory;
  status?: "available" | "coming_soon" | "beta";
  search?: string;
}
