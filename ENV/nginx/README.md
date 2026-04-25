# Reverse proxy / TLS termination

Two ready-to-paste configs for the production deploy. Pick one — don't run
both. The Caddy path is simpler if you don't already have nginx installed
or if you want auto-cert with no extra commands; the nginx path is the
right choice if you already have nginx serving other sites on the same
host or want fine-grained tuning.

## Option A — nginx + certbot (sample at `braavolabs.conf`)

1. Install: `apt update && apt install -y nginx certbot python3-certbot-nginx`
2. Copy: `cp ENV/nginx/braavolabs.conf /etc/nginx/sites-available/braavolabs.conf`
3. Enable: `ln -s /etc/nginx/sites-available/braavolabs.conf /etc/nginx/sites-enabled/`
4. Test: `nginx -t`
5. Reload: `systemctl reload nginx`
6. Issue certs:
   ```
   certbot --nginx -d braavolabs.com -d www.braavolabs.com \
                   -d api.braavolabs.com -d app.braavolabs.com
   ```
7. Auto-renew is wired by certbot's systemd timer — no extra cron needed.

## Option B — Caddy (sample at `Caddyfile`)

1. Install: `curl -fsSL https://get.caddyserver.com | sh`
2. Copy: `cp ENV/nginx/Caddyfile /etc/caddy/Caddyfile`
3. Edit the email at the top of `Caddyfile` (Let's Encrypt registration).
4. Reload: `systemctl reload caddy`

Caddy fetches certs on first request to each hostname; no extra setup.

## What both configs handle

| Concern | nginx | Caddy |
|---|---|---|
| TLS 1.2 + 1.3 | ✓ | ✓ (default) |
| HSTS + security headers | ✓ | ✓ |
| HTTP → HTTPS redirect | ✓ explicit | ✓ automatic |
| Edge rate limit (5 r/s burst 50) | ✓ | not configured (Express handles) |
| `/api/v1/runs/*` SSE streaming | proxy_buffering off, 1h read | flush_interval -1 |
| `/hooks/stripe` raw body pass-through | proxy_request_buffering off | request_buffers 0 |
| `/health` rate-limit bypass | ✓ | ✓ (log_skip) |
| `/_next/static/*` 1-year cache | ✓ | ✓ |
| Real client IP forwarded | X-Real-IP + X-Forwarded-For | header_up by default |
| Body limit (matches Express 1MB JSON cap + margin) | 2m | default ample |

## Cloudflare in front (optional)

If you proxy through Cloudflare (orange cloud in DNS), origin still terminates
TLS — Cloudflare → origin is a second TLS leg. Use Cloudflare's "Full
(strict)" mode and either:
- Keep the Let's Encrypt cert on the origin (free, what these configs assume), or
- Use a Cloudflare Origin Cert (15-year, only valid on Cloudflare's network).

`trust proxy = 1` is set in `packages/api/src/index.ts` for the production
case (single proxy in front). If you put both Cloudflare AND nginx in front,
bump that to `2`.
