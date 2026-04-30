# Custom Domain Split — `app.braavolabs.com` + `api.braavolabs.com`

The current production setup serves UI and API from the same origin
(`braavolabs.com` + `/api/v1/*`). This works for launch, but a few
launch-adjacent decisions push toward splitting them once the platform
matures:

- **Stripe webhook hygiene** — webhook endpoints conventionally live at
  `api.<domain>` so security/incident rotation can swap the API host
  without breaking the marketing site.
- **CDN policy** — UI gets aggressive caching (30 d immutable assets,
  HTML edge cache); API needs `Cache-Control: no-store` everywhere.
  Same-origin forces both to share a CF rule set.
- **Subdomain DNS = independent SSL renew cycles** — separate hosts mean
  separate cert lifecycles. No "API down because UI cert renewal stalled."
- **Future apps** — `dashboard.braavolabs.com`, `docs.braavolabs.com`,
  `status.braavolabs.com` all become trivial once the split exists.

This runbook ships the **infra plan**. Code is already prepared:

- `packages/api/src/index.ts` reads `ALLOWED_ORIGINS` env (comma-separated)
  and adds those hosts to the CORS allowlist alongside `APP_URL`.
- `packages/ui/next.config.ts` CSP `connect-src` accepts
  `${process.env.NEXT_PUBLIC_API_URL}` — pointing this at
  `https://api.braavolabs.com/api/v1` is a single env-var flip.
- `metadataBase` in `packages/ui/app/layout.tsx` falls back to
  `https://braavolabs.com` so OG/Twitter URLs resolve absolutely.

---

## Step 1 — Cloudflare DNS

Add two new A records (or CNAMEs to the same Lightsail IP):

| Name | Type | Content | Proxy |
|---|---|---|---|
| `app` | A | `63.180.74.27` | ✅ Proxied (orange cloud) |
| `api` | A | `63.180.74.27` | ✅ Proxied |

Keep the apex `braavolabs.com` A record as is — it stays as the marketing
site (or can be swapped to a 301 redirect to `app` after launch).

## Step 2 — nginx vhosts on the Lightsail host

Replace the current single-vhost nginx config with three blocks:

```nginx
# /opt/braavolabs/app/ENV/nginx/sites/braavolabs.conf

# Marketing/apex — same as today
server {
    listen 443 ssl http2;
    server_name braavolabs.com;
    # ... existing config (proxies to ui:3000) ...
}

# UI — app.braavolabs.com → Next.js (ui container)
server {
    listen 443 ssl http2;
    server_name app.braavolabs.com;
    location / {
        proxy_pass http://ui:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# API — api.braavolabs.com → Express (api container)
server {
    listen 443 ssl http2;
    server_name api.braavolabs.com;
    location / {
        proxy_pass http://api:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # API-side caching policy
        add_header Cache-Control "no-store" always;
    }
}
```

Cloudflare's edge handles SSL termination via Universal SSL — origin nginx
can stay on plaintext or use the existing wildcard cert.

## Step 3 — Production env vars

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@63.180.74.27
sudo nano /opt/braavolabs/app/.env
# Update:
APP_URL=https://app.braavolabs.com
NEXT_PUBLIC_APP_URL=https://app.braavolabs.com
NEXT_PUBLIC_API_URL=https://api.braavolabs.com/api/v1
GOOGLE_REDIRECT_URI=https://api.braavolabs.com/api/v1/auth/google/callback
GITHUB_REDIRECT_URI=https://api.braavolabs.com/api/v1/auth/github/callback
# New — comma-separated extra CORS origins. Lets requests from the
# apex marketing site (or a future blog subdomain) reach the API.
ALLOWED_ORIGINS=https://braavolabs.com,https://www.braavolabs.com
```

## Step 4 — OAuth provider redirect URI updates

Each OAuth app's redirect URI must match exactly. Update both:

- **Google** — https://console.cloud.google.com/apis/credentials → OAuth
  client → Authorized redirect URIs → add
  `https://api.braavolabs.com/api/v1/auth/google/callback`. Keep the old
  `https://braavolabs.com/...` entry for ~24 h to bridge in-flight sessions.
- **GitHub** — https://github.com/settings/developers → OAuth App →
  Authorization callback URL → swap to
  `https://api.braavolabs.com/api/v1/auth/github/callback`.

## Step 5 — Stripe webhook endpoint

In Stripe Dashboard (live mode) → Developers → Webhooks → existing
endpoint → Update endpoint URL:
- Old: `https://braavolabs.com/api/v1/billing/webhook`
- New: `https://api.braavolabs.com/api/v1/billing/webhook`

Stripe will start sending events to the new URL within 5 minutes; keep
the old endpoint receiving for 24 h as fallback.

## Step 6 — Restart + smoke tests

```bash
sudo docker compose --env-file /opt/braavolabs/app/.env \
  -f /opt/braavolabs/app/ENV/compose.prod.yaml \
  up -d --force-recreate api ui
sudo systemctl reload nginx

# Health
curl -sS https://api.braavolabs.com/api/v1/health
curl -sS -I https://app.braavolabs.com/

# CORS preflight
curl -sS -i -X OPTIONS https://api.braavolabs.com/api/v1/health \
  -H "Origin: https://app.braavolabs.com" \
  -H "Access-Control-Request-Method: GET" | grep -i access-control

# OAuth round-trip (manual, browser): https://app.braavolabs.com/login → Google → land back on app.
```

## Rollback

```bash
# Revert env vars to the apex-only config:
APP_URL=https://braavolabs.com
NEXT_PUBLIC_API_URL=https://braavolabs.com/api/v1
# ... etc
sudo docker compose ... up -d --force-recreate api ui
```

DNS records can stay (they cost nothing); just point env vars back.

## Notes

- The `apex → app` 301 redirect is intentionally **not** in this runbook.
  Marketing usually wants the bare domain to keep working as a brand
  surface. If we ever decide otherwise, add a single nginx rule under the
  apex vhost and call it a day.
- `metadataBase` in `layout.tsx` is read at build time, so the UI build
  embedded after the env-var flip will produce correct absolute URLs in
  the OG/Twitter tags.
- AI Visibility note: Google's recrawl after a domain change can take
  ~1 week. Submit the new sitemap URL in Google Search Console
  (`https://app.braavolabs.com/sitemap.xml`) the same day to accelerate.
