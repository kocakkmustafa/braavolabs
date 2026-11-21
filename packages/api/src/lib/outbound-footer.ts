/**
 * Legal footer for outbound contact email: opt-out text (with the signed
 * one-click link) and the sender's physical address. Text comes from env via
 * getOutboundLegalConfig(); nothing is hard-coded. Missing config or a
 * non-https API origin => LEGAL_CONFIG_MISSING (never a silent unfooted send).
 */
import { logger } from "./logger";
import {
  getOutboundLegalConfig,
  legalConfigMissingError,
  missingEmailLegalConfig,
} from "./outbound-gates";
import { buildUnsubscribeUrl } from "./unsubscribe-token";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function appendLegalFooter(body: string, tenantId: string, to: string): string {
  const config = getOutboundLegalConfig();
  const missing = missingEmailLegalConfig(config);
  const url = missing.length === 0 ? buildUnsubscribeUrl(tenantId, to) : null;
  if (missing.length > 0 || !url || !config.unsubscribeText || !config.senderAddress) {
    logger.warn(
      { missing: url ? missing : [...missing, "https API_PUBLIC_URL"] },
      "Outbound email refused — legal config incomplete (LEGAL_CONFIG_MISSING)",
    );
    throw legalConfigMissingError();
  }
  const optOut = escapeHtml(config.unsubscribeText).replace(
    /\{url\}/g,
    `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`,
  );
  const address = escapeHtml(config.senderAddress).replace(/\r?\n/g, "<br>");
  return `${body}<hr><p>${optOut}</p><p>${address}</p>`;
}
