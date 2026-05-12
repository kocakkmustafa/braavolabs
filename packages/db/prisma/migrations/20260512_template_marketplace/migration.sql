-- Company template marketplace (Feature 9).
--
-- Catalog of installable "freeze-dried" companies. Each template
-- carries a JSON snapshot of pipelines + agents + memory seeds
-- which the install endpoint replays into a new Company in the
-- installing tenant.

CREATE TYPE "TemplatePricing" AS ENUM ('FREE', 'PAID');
CREATE TYPE "TemplateVisibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

CREATE TABLE "company_templates" (
  "id"                  TEXT PRIMARY KEY,
  "slug"                TEXT NOT NULL UNIQUE,
  "name"                TEXT NOT NULL,
  "version"             TEXT NOT NULL DEFAULT '1.0.0',
  "vendor"              TEXT NOT NULL,
  "description"         TEXT NOT NULL,
  "icon_url"            TEXT,
  "screenshot_urls"     JSONB NOT NULL DEFAULT '[]',
  "snapshot"            JSONB NOT NULL,
  "primitives"          JSONB NOT NULL DEFAULT '[]',
  "pricing"             "TemplatePricing" NOT NULL DEFAULT 'FREE',
  "price_usd"           DECIMAL(10, 2),
  "visibility"          "TemplateVisibility" NOT NULL DEFAULT 'PRIVATE',
  "is_approved"         BOOLEAN NOT NULL DEFAULT false,
  "publisher_tenant_id" TEXT,
  "install_count"       INTEGER NOT NULL DEFAULT 0,
  "rating_avg"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rating_count"        INTEGER NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL
);
CREATE INDEX "company_templates_visibility_is_approved_install_count_idx"
  ON "company_templates"("visibility", "is_approved", "install_count" DESC);

CREATE TABLE "template_ratings" (
  "id"          TEXT PRIMARY KEY,
  "template_id" TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "rating"      INTEGER NOT NULL,
  "review"      TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "template_ratings_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "company_templates"("id") ON DELETE CASCADE,
  CONSTRAINT "template_ratings_template_id_tenant_id_unique"
    UNIQUE ("template_id", "tenant_id"),
  CONSTRAINT "template_ratings_rating_bounds"
    CHECK ("rating" BETWEEN 1 AND 5)
);
CREATE INDEX "template_ratings_template_id_idx" ON "template_ratings"("template_id");

CREATE TABLE "template_installs" (
  "id"                       TEXT PRIMARY KEY,
  "template_id"              TEXT NOT NULL,
  "tenant_id"                TEXT NOT NULL,
  "installed_company_id"     TEXT,
  "price_paid_usd"           DECIMAL(10, 2),
  "stripe_payment_intent_id" TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "template_installs_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "company_templates"("id") ON DELETE CASCADE,
  CONSTRAINT "template_installs_unique_per_company"
    UNIQUE ("template_id", "tenant_id", "installed_company_id")
);
CREATE INDEX "template_installs_tenant_id_idx" ON "template_installs"("tenant_id");
CREATE INDEX "template_installs_template_id_idx" ON "template_installs"("template_id");
