/** Sayfanın kendisi `id="main-content"` taşıyan yollar: kabuk (AuthLayout) aynı kimliği ikinci kez vermez (tek hedef). */
export const OWN_MAIN_CONTENT_PATHS = ["/terms", "/privacy", "/kvkk", "/cookies", "/gdpr", "/features", "/pricing", "/security", "/docs", "/status", "/support", "/about", "/blog", "/changelog", "/compare", "/contact", "/cost-calculator", "/legal/account-deletion", "/"];
export const ownsMain = (path: string) => OWN_MAIN_CONTENT_PATHS.includes(path) || path.startsWith("/docs/") || path.startsWith("/blog/");
