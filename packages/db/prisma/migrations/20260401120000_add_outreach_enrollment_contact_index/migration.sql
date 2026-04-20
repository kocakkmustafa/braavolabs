-- CreateIndex
-- NOTE: Column is mapped via @map("contact_id") so physical name is snake_case.
-- Earlier version used "contactId" and failed on fresh databases.
CREATE INDEX IF NOT EXISTS "outreach_enrollments_contact_id_idx" ON "outreach_enrollments"("contact_id");
