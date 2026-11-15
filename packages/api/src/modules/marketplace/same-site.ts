/** BRA-P1-02a-2: same-site check used before credentials are sent to any provider endpoint. */

/**
 * Multi-part public suffixes and shared-hosting suffixes (small built-in list,
 * no dependency). A suffix here is never a registrable domain itself:
 * `a.co.uk` and `b.co.uk` (or `a.github.io` and `b.github.io`) are different
 * sites. Single-label TLDs (com, io, example ...) are handled implicitly.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.tr", "org.tr", "net.tr", "gen.tr",
  "com.au", "net.au", "org.au",
  "co.jp", "ne.jp", "or.jp",
  "co.in", "com.br", "com.cn", "co.nz", "co.za", "com.mx", "com.sg", "com.hk",
  // shared hosting: every customer gets a subdomain of these
  "github.io", "vercel.app", "netlify.app", "herokuapp.com", "azurewebsites.net",
  "cloudfront.net", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "appspot.com", "onrender.com", "fly.dev", "ngrok.io",
]);

function hostnameOf(url: string): string | null {
  try {
    const u = new URL(url);
    let h = u.hostname.toLowerCase();
    while (h.endsWith(".")) h = h.slice(0, -1);
    return h || null;
  } catch {
    return null;
  }
}

function isIpHost(h: string): boolean {
  return h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

/** Registrable domain (eTLD+1) of a hostname, or null when the host is itself a suffix / has no registrable part. */
function registrableDomain(host: string): string | null {
  const labels = host.split(".");
  if (labels.length < 2) return null;
  for (let n = Math.min(labels.length, 3); n >= 2; n--) {
    if (MULTI_PART_SUFFIXES.has(labels.slice(-n).join("."))) {
      return labels.length > n ? labels.slice(-(n + 1)).join(".") : null;
    }
  }
  return labels.slice(-2).join(".");
}

/**
 * Credential-leak guard: the URL (token/revocation endpoint) must be the connector's registered
 * domain (eTLD+1) or a subdomain of it. Hostname only; port/path ignored.
 * IPs and single-label hosts require exact equality. Fails closed on bad URLs.
 */
export function isSameSiteUrl(url: string, mcpServerUrl: string): boolean {
  const t = hostnameOf(url);
  const m = hostnameOf(mcpServerUrl);
  if (!t || !m) return false;
  if (t === m) return true;
  if (isIpHost(t) || isIpHost(m)) return false;
  const reg = registrableDomain(m);
  if (!reg) return false;
  return t === reg || t.endsWith("." + reg);
}

/** Credential URL fields that receive tokens/secrets; each must be same-site with the connector. */
export const CREDENTIAL_URL_FIELDS = ["tokenUrl", "revocationUrl", "revokeUrl"] as const;

/** Name of the first credential URL field that is set but not same-site, else null. */
export function firstOffSiteCredentialUrl(creds: Record<string, unknown>, mcpServerUrl: string): string | null {
  for (const f of CREDENTIAL_URL_FIELDS) {
    const v = creds[f];
    if (v !== undefined && v !== null && v !== "" && !(typeof v === "string" && isSameSiteUrl(v, mcpServerUrl))) return f;
  }
  return null;
}
