# Security Policy

## API Key Management
- All API keys stored as environment variables, never in code
- Keys rotated every 90 days
- Separate keys per environment (dev/staging/prod)

## Data Access
- Tenant isolation enforced at database query level
- Every query MUST include tenant_id filter
- No cross-tenant data access permitted

## Authentication
- JWT tokens with expiry (default: 7 days)
- OAuth2 (Google) for SSO
- Rate limiting on all endpoints

## Secrets
- No secrets in git history
- .env files gitignored
- Production secrets in environment variables or secret manager
