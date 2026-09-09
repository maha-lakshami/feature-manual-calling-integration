-- Forward-only migration: Phase 5 WhatsApp Shadow Reconciliation Safeguards
-- 1. Allow occurred_at to be nullable in whatsapp_shadow_ratings for durable INVALID_STATE without timestamp fabrication
ALTER TABLE "whatsapp_shadow_ratings" ALTER COLUMN "occurred_at" DROP NOT NULL;

-- 2. Add version, is_final, and eligible_recipients to whatsapp_campaign_shadow_reconciliations
ALTER TABLE "whatsapp_campaign_shadow_reconciliations" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "whatsapp_campaign_shadow_reconciliations" ADD COLUMN "is_final" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_campaign_shadow_reconciliations" ADD COLUMN "eligible_recipients" INTEGER NOT NULL DEFAULT 0;

-- 3. Replace single-row campaign unique constraint with versioned uniqueness
DROP INDEX IF EXISTS "whatsapp_campaign_reconciliations_tenant_campaign_unique";

CREATE UNIQUE INDEX "whatsapp_campaign_reconciliations_tenant_campaign_version_unique" 
    ON "whatsapp_campaign_shadow_reconciliations"("tenant_id", "campaign_id", "version");

CREATE INDEX "whatsapp_campaign_shadow_reconciliations_tenant_campaign_version_idx" 
    ON "whatsapp_campaign_shadow_reconciliations"("tenant_id", "campaign_id", "version" DESC);
