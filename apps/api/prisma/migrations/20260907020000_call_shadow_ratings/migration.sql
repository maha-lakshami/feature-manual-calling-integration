-- AlterTable
ALTER TABLE "calls" ADD COLUMN "provider" TEXT;

-- CreateTable
CREATE TABLE "call_shadow_ratings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "provider" TEXT,
    "provider_reference" TEXT,
    "billable_seconds" INTEGER,
    "rate_micro_paise" BIGINT,
    "provider_cost_micro_paise" BIGINT,
    "markup_bps" INTEGER,
    "markup_amount_micro_paise" BIGINT,
    "retail_amount_micro_paise" BIGINT,
    "legacy_customer_charge_paise" BIGINT NOT NULL,
    "shadow_customer_charge_paise" BIGINT,
    "difference_paise" BIGINT,
    "status" TEXT NOT NULL,
    "unavailable_reason" TEXT,
    "cost_source" "CostSource",
    "provider_rate_id" UUID,
    "policy_reference" TEXT,
    "occurred_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
    "rated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_shadow_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_shadow_ratings_tenant_id_call_id_key" ON "call_shadow_ratings"("tenant_id", "call_id");

-- CreateIndex
CREATE INDEX "call_shadow_ratings_tenant_id_rated_at_idx" ON "call_shadow_ratings"("tenant_id", "rated_at" DESC);

-- CreateIndex
CREATE INDEX "call_shadow_ratings_call_id_idx" ON "call_shadow_ratings"("call_id");

-- CreateIndex
CREATE INDEX "call_shadow_ratings_status_idx" ON "call_shadow_ratings"("status");

-- AddForeignKey
ALTER TABLE "call_shadow_ratings" ADD CONSTRAINT "call_shadow_ratings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_shadow_ratings" ADD CONSTRAINT "call_shadow_ratings_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_shadow_ratings" ADD CONSTRAINT "call_shadow_ratings_provider_rate_id_fkey" FOREIGN KEY ("provider_rate_id") REFERENCES "provider_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
