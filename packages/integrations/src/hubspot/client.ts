/**
 * HubSpot CRM Client — Faz 3
 *
 * Wraps @hubspot/api-client for contact/deal sync.
 */

export interface HubSpotConfig {
  accessToken: string;
  portalId: string;
}

export async function syncContacts(_config: HubSpotConfig, _companyId: string): Promise<void> {
  // TODO: Faz 3
  throw new Error("Not implemented — Faz 3");
}

export async function syncDeals(_config: HubSpotConfig, _companyId: string): Promise<void> {
  // TODO: Faz 3
  throw new Error("Not implemented — Faz 3");
}

export async function createHubSpotContact(
  _config: HubSpotConfig,
  _contact: Record<string, unknown>,
): Promise<string> {
  // TODO: Faz 3
  throw new Error("Not implemented — Faz 3");
}
