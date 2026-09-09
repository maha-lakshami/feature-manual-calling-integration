-- AlterTable: Add operational provider billing fields to campaign_recipients
ALTER TABLE "campaign_recipients" ADD COLUMN "provider" TEXT;
ALTER TABLE "campaign_recipients" ADD COLUMN "provider_billable" BOOLEAN;
ALTER TABLE "campaign_recipients" ADD COLUMN "provider_category" TEXT;
ALTER TABLE "campaign_recipients" ADD COLUMN "provider_pricing_model" TEXT;
ALTER TABLE "campaign_recipients" ADD COLUMN "pricing_observed_at" TIMESTAMP(3) WITH TIME ZONE;

-- CreateTable: whatsapp_shadow_ratings (immutable per-recipient provider cost observation)
CREATE TABLE "whatsapp_shadow_ratings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "campaign_recipient_id" UUID NOT NULL,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "destination" TEXT NOT NULL,
    "category" TEXT,
    "pricing_model" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "rate_micro_paise" BIGINT,
    "provider_cost_micro_paise" BIGINT,
    "legacy_customer_charge_paise" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "unavailable_reason" TEXT,
    "cost_source" "CostSource",
    "provider_rate_id" UUID,
    "policy_reference" TEXT,
    "occurred_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
    "rated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_shadow_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable: whatsapp_campaign_shadow_reconciliations (immutable aggregate campaign shadow retail)
CREATE TABLE "whatsapp_campaign_shadow_reconciliations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "total_recipients" INTEGER NOT NULL,
    "rated_recipients" INTEGER NOT NULL,
    "unrated_recipients" INTEGER NOT NULL,
    "non_billable_recipients" INTEGER NOT NULL,
    "total_provider_cost_micro_paise" BIGINT NOT NULL,
    "markup_bps" INTEGER NOT NULL,
    "markup_amount_micro_paise" BIGINT NOT NULL,
    "retail_amount_micro_paise" BIGINT NOT NULL,
    "rated_legacy_total_paise" BIGINT NOT NULL,
    "rated_shadow_total_paise" BIGINT NOT NULL,
    "signed_difference_paise" BIGINT NOT NULL,
    "variance_bps" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "rated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_campaign_shadow_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable: whatsapp_shadow_rating_conflicts (append-only duplicate replay audit log)
CREATE TABLE "whatsapp_shadow_rating_conflicts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "campaign_recipient_id" UUID NOT NULL,
    "shadow_rating_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "incoming_values" JSONB NOT NULL,
    "existing_values" JSONB NOT NULL,
    "detected_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_shadow_rating_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: whatsapp_shadow_ratings
CREATE UNIQUE INDEX "whatsapp_shadow_ratings_campaign_recipient_id_key" ON "whatsapp_shadow_ratings"("campaign_recipient_id");
CREATE UNIQUE INDEX "whatsapp_shadow_ratings_tenant_recipient_unique" ON "whatsapp_shadow_ratings"("tenant_id", "campaign_recipient_id");
CREATE INDEX "whatsapp_shadow_ratings_tenant_id_rated_at_idx" ON "whatsapp_shadow_ratings"("tenant_id", "rated_at" DESC);
CREATE INDEX "whatsapp_shadow_ratings_campaign_id_idx" ON "whatsapp_shadow_ratings"("campaign_id");
CREATE INDEX "whatsapp_shadow_ratings_provider_message_id_idx" ON "whatsapp_shadow_ratings"("provider_message_id");
CREATE INDEX "whatsapp_shadow_ratings_status_idx" ON "whatsapp_shadow_ratings"("status");

-- CreateIndex: whatsapp_campaign_shadow_reconciliations
CREATE UNIQUE INDEX "whatsapp_campaign_reconciliations_tenant_campaign_unique" ON "whatsapp_campaign_shadow_reconciliations"("tenant_id", "campaign_id");
CREATE INDEX "whatsapp_campaign_shadow_reconciliations_tenant_id_rated_at_idx" ON "whatsapp_campaign_shadow_reconciliations"("tenant_id", "rated_at" DESC);

-- CreateIndex: whatsapp_shadow_rating_conflicts
CREATE INDEX "whatsapp_shadow_rating_conflicts_tenant_id_detected_at_idx" ON "whatsapp_shadow_rating_conflicts"("tenant_id", "detected_at" DESC);
CREATE INDEX "whatsapp_shadow_rating_conflicts_campaign_recipient_id_idx" ON "whatsapp_shadow_rating_conflicts"("campaign_recipient_id");
CREATE INDEX "whatsapp_shadow_rating_conflicts_shadow_rating_id_idx" ON "whatsapp_shadow_rating_conflicts"("shadow_rating_id");

-- AddForeignKey: whatsapp_shadow_ratings
ALTER TABLE "whatsapp_shadow_ratings" ADD CONSTRAINT "whatsapp_shadow_ratings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_shadow_ratings" ADD CONSTRAINT "whatsapp_shadow_ratings_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_shadow_ratings" ADD CONSTRAINT "whatsapp_shadow_ratings_campaign_recipient_id_fkey" FOREIGN KEY ("campaign_recipient_id") REFERENCES "campaign_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_shadow_ratings" ADD CONSTRAINT "whatsapp_shadow_ratings_provider_rate_id_fkey" FOREIGN KEY ("provider_rate_id") REFERENCES "provider_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: whatsapp_campaign_shadow_reconciliations
ALTER TABLE "whatsapp_campaign_shadow_reconciliations" ADD CONSTRAINT "whatsapp_campaign_shadow_reconciliations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_campaign_shadow_reconciliations" ADD CONSTRAINT "whatsapp_campaign_shadow_reconciliations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: whatsapp_shadow_rating_conflicts
ALTER TABLE "whatsapp_shadow_rating_conflicts" ADD CONSTRAINT "whatsapp_shadow_rating_conflicts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_shadow_rating_conflicts" ADD CONSTRAINT "whatsapp_shadow_rating_conflicts_campaign_recipient_id_fkey" FOREIGN KEY ("campaign_recipient_id") REFERENCES "campaign_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_shadow_rating_conflicts" ADD CONSTRAINT "whatsapp_shadow_rating_conflicts_shadow_rating_id_fkey" FOREIGN KEY ("shadow_rating_id") REFERENCES "whatsapp_shadow_ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
