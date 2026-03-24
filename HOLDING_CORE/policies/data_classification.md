# Data Classification Policy

## Classification Levels

### PUBLIC
- Published content (social posts, blog posts)
- Company names and descriptions
- Aggregate analytics

### INTERNAL
- Pipeline configurations
- Agent system prompts
- Memory items
- Run logs and activity history

### CONFIDENTIAL
- API keys and credentials
- User personal data (email, name)
- Financial data (costs, billing)
- CRM contact information
- Deal amounts and stages

### RESTRICTED
- Authentication tokens
- Encryption keys
- Database credentials

## Handling Rules
- CONFIDENTIAL and RESTRICTED data must not appear in logs
- PII must be redactable on request (GDPR compliance)
- Audit logs retain for 1 year, then archive
