-- AlterTable
ALTER TABLE "call_shadow_rating_conflicts" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "detected_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "call_shadow_ratings" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "occurred_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "bridge_number" TEXT,
ADD COLUMN     "call_type" TEXT NOT NULL DEFAULT 'ai';

-- AlterTable
ALTER TABLE "campaign_recipients" ALTER COLUMN "pricing_observed_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "email_campaign_shadow_reconciliations" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "rated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "email_shadow_rating_conflicts" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "detected_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "email_shadow_ratings" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "occurred_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "whatsapp_campaign_shadow_reconciliations" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "rated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "whatsapp_shadow_rating_conflicts" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "detected_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "whatsapp_shadow_ratings" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "occurred_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- RenameIndex
ALTER INDEX "email_campaign_reconciliations_tenant_campaign_version_unique" RENAME TO "email_campaign_shadow_reconciliations_tenant_id_campaign_id_key";

-- RenameIndex
ALTER INDEX "email_shadow_ratings_tenant_recipient_version_unique" RENAME TO "email_shadow_ratings_tenant_id_campaign_recipient_id_rating_key";

-- RenameIndex
ALTER INDEX "whatsapp_campaign_reconciliations_tenant_campaign_version_uniqu" RENAME TO "whatsapp_campaign_shadow_reconciliations_tenant_id_campaign_key";

-- RenameIndex
ALTER INDEX "whatsapp_campaign_shadow_reconciliations_tenant_campaign_versio" RENAME TO "whatsapp_campaign_reconciliations_tenant_campaign_version_idx";

-- RenameIndex
ALTER INDEX "whatsapp_shadow_ratings_tenant_recipient_version_unique" RENAME TO "whatsapp_shadow_ratings_tenant_id_campaign_recipient_id_rat_key";
