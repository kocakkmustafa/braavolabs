-- Voice/phone agent primitive (Feature 6).
--
-- Schema only — provider integration (Vapi / Twilio / Retell) and
-- the actual phone-number provisioning happen against operator-
-- supplied credentials in a deploy-time runbook.

CREATE TYPE "VoiceProvider" AS ENUM ('VAPI', 'TWILIO_DEEPGRAM', 'RETELL', 'CUSTOM');

-- Voice providers also need entries in the existing IntegrationProvider
-- enum so a tenant can store credentials per company under the same
-- /integrations CRUD it uses for every other provider. Adding values
-- to a PG enum requires ALTER TYPE.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'VAPI';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'RETELL';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'VOICE_CUSTOM';
CREATE TYPE "VoiceCallDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "VoiceCallStatus" AS ENUM ('RINGING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY');

CREATE TABLE "voice_agents" (
  "id"               TEXT PRIMARY KEY,
  "company_id"       TEXT NOT NULL,
  "agent_id"         TEXT UNIQUE,
  "name"             TEXT NOT NULL,
  "phone_number"     TEXT UNIQUE,
  "provider"         "VoiceProvider" NOT NULL DEFAULT 'VAPI',
  "voice_config"     JSONB NOT NULL DEFAULT '{}',
  "inbound_enabled"  BOOLEAN NOT NULL DEFAULT true,
  "outbound_per_hour" INTEGER,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "voice_agents_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "voice_agents_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL
);
CREATE INDEX "voice_agents_company_id_idx" ON "voice_agents"("company_id");

CREATE TABLE "voice_calls" (
  "id"                       TEXT PRIMARY KEY,
  "voice_agent_id"           TEXT NOT NULL,
  "tenant_id"                TEXT NOT NULL,
  "direction"                "VoiceCallDirection" NOT NULL,
  "caller_number"            TEXT NOT NULL,
  "callee_number"            TEXT NOT NULL,
  "status"                   "VoiceCallStatus" NOT NULL DEFAULT 'RINGING',
  "duration_seconds"         INTEGER,
  "transcript"               JSONB,
  "recording_url"            TEXT,
  "cost_usd"                 DECIMAL(10, 4),
  "initiated_by_run_step_id" TEXT,
  "provider_call_id"         TEXT UNIQUE,
  "started_at"               TIMESTAMP(3),
  "ended_at"                 TIMESTAMP(3),
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,

  CONSTRAINT "voice_calls_voice_agent_id_fkey"
    FOREIGN KEY ("voice_agent_id") REFERENCES "voice_agents"("id") ON DELETE CASCADE
);
CREATE INDEX "voice_calls_voice_agent_id_created_at_idx"
  ON "voice_calls"("voice_agent_id", "created_at" DESC);
CREATE INDEX "voice_calls_tenant_id_created_at_idx"
  ON "voice_calls"("tenant_id", "created_at" DESC);
