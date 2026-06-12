-- Apple 5.1.2(i): per-user revocable consent for third-party AI data sharing
ALTER TABLE "users" ADD COLUMN "ai_consent_at" TIMESTAMP(3);
