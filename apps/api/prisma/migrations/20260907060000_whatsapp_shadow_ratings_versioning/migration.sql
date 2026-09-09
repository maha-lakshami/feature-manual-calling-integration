-- AlterTable: add rating_version
ALTER TABLE "whatsapp_shadow_ratings" ADD COLUMN "rating_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: make billable nullable
ALTER TABLE "whatsapp_shadow_ratings" ALTER COLUMN "billable" DROP NOT NULL;
ALTER TABLE "whatsapp_shadow_ratings" ALTER COLUMN "billable" DROP DEFAULT;

-- Drop prior 1:1 unique constraints on recipient
DROP INDEX IF EXISTS "whatsapp_shadow_ratings_campaign_recipient_id_key";
DROP INDEX IF EXISTS "whatsapp_shadow_ratings_tenant_recipient_unique";

-- Create unique index on (tenant_id, campaign_recipient_id, rating_version)
CREATE UNIQUE INDEX "whatsapp_shadow_ratings_tenant_recipient_version_unique" 
  ON "whatsapp_shadow_ratings"("tenant_id", "campaign_recipient_id", "rating_version");

-- Create index for latest version lookup
CREATE INDEX "whatsapp_shadow_ratings_tenant_recipient_version_idx" 
  ON "whatsapp_shadow_ratings"("tenant_id", "campaign_recipient_id", "rating_version" DESC);
