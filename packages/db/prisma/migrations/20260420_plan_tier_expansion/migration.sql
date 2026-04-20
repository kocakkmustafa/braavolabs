-- Expand Plan enum for new tier structure (2026-04):
-- Free → Creator ($19) → Pro ($39) → Business ($99) → Enterprise
-- Existing PRO tenants remain PRO. New tiers added to enum only.

ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'CREATOR';
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'BUSINESS';
