-- Phase 6: immutable observational email provider-cost ratings.
CREATE TABLE "email_shadow_ratings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "campaign_recipient_id" UUID NOT NULL,
    "rating_version" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "destination" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'email',
    "rate_micro_paise" BIGINT,
    "provider_cost_micro_paise" BIGINT,
    "legacy_customer_charge_paise" BIGINT,
    "status" TEXT NOT NULL,
    "unavailable_reason" TEXT,
    "cost_source" "CostSource",
    "provider_rate_id" UUID,
    "policy_reference" TEXT,
    "occurred_at" TIMESTAMP(3) WITH TIME ZONE,
    "rated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_shadow_ratings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_campaign_shadow_reconciliations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "total_recipients" INTEGER NOT NULL,
    "eligible_recipients" INTEGER NOT NULL,
    "rated_recipients" INTEGER NOT NULL,
    "unrated_recipients" INTEGER NOT NULL,
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
    CONSTRAINT "email_campaign_shadow_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_shadow_rating_conflicts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "campaign_recipient_id" UUID NOT NULL,
    "shadow_rating_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "incoming_values" JSONB NOT NULL,
    "existing_values" JSONB NOT NULL,
    "detected_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_shadow_rating_conflicts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_shadow_ratings_tenant_recipient_version_unique" ON "email_shadow_ratings"("tenant_id", "campaign_recipient_id", "rating_version");
CREATE INDEX "email_shadow_ratings_tenant_recipient_version_idx" ON "email_shadow_ratings"("tenant_id", "campaign_recipient_id", "rating_version" DESC);
CREATE INDEX "email_shadow_ratings_tenant_id_rated_at_idx" ON "email_shadow_ratings"("tenant_id", "rated_at" DESC);
CREATE INDEX "email_shadow_ratings_campaign_id_idx" ON "email_shadow_ratings"("campaign_id");
CREATE INDEX "email_shadow_ratings_provider_message_id_idx" ON "email_shadow_ratings"("provider_message_id");
CREATE INDEX "email_shadow_ratings_status_idx" ON "email_shadow_ratings"("status");

CREATE UNIQUE INDEX "email_campaign_reconciliations_tenant_campaign_version_unique" ON "email_campaign_shadow_reconciliations"("tenant_id", "campaign_id", "version");
CREATE INDEX "email_campaign_shadow_reconciliations_tenant_id_rated_at_idx" ON "email_campaign_shadow_reconciliations"("tenant_id", "rated_at" DESC);
CREATE INDEX "email_campaign_reconciliations_tenant_campaign_version_idx" ON "email_campaign_shadow_reconciliations"("tenant_id", "campaign_id", "version" DESC);

CREATE INDEX "email_shadow_rating_conflicts_tenant_id_detected_at_idx" ON "email_shadow_rating_conflicts"("tenant_id", "detected_at" DESC);
CREATE INDEX "email_shadow_rating_conflicts_campaign_recipient_id_idx" ON "email_shadow_rating_conflicts"("campaign_recipient_id");
CREATE INDEX "email_shadow_rating_conflicts_shadow_rating_id_idx" ON "email_shadow_rating_conflicts"("shadow_rating_id");

ALTER TABLE "email_shadow_ratings" ADD CONSTRAINT "email_shadow_ratings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_shadow_ratings" ADD CONSTRAINT "email_shadow_ratings_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_shadow_ratings" ADD CONSTRAINT "email_shadow_ratings_campaign_recipient_id_fkey" FOREIGN KEY ("campaign_recipient_id") REFERENCES "campaign_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_shadow_ratings" ADD CONSTRAINT "email_shadow_ratings_provider_rate_id_fkey" FOREIGN KEY ("provider_rate_id") REFERENCES "provider_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "email_campaign_shadow_reconciliations" ADD CONSTRAINT "email_campaign_shadow_reconciliations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_campaign_shadow_reconciliations" ADD CONSTRAINT "email_campaign_shadow_reconciliations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "email_shadow_rating_conflicts" ADD CONSTRAINT "email_shadow_rating_conflicts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_shadow_rating_conflicts" ADD CONSTRAINT "email_shadow_rating_conflicts_campaign_recipient_id_fkey" FOREIGN KEY ("campaign_recipient_id") REFERENCES "campaign_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_shadow_rating_conflicts" ADD CONSTRAINT "email_shadow_rating_conflicts_shadow_rating_id_fkey" FOREIGN KEY ("shadow_rating_id") REFERENCES "email_shadow_ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
