-- CreateTable
CREATE TABLE "provider_rates" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "destination_pattern" TEXT NOT NULL DEFAULT '*',
    "category" TEXT,
    "unit" TEXT NOT NULL,
    "rate_micro_paise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_rates_provider_channel_active_effective_from_idx" ON "provider_rates"("provider", "channel", "active", "effective_from");

-- CreateIndex
CREATE INDEX "provider_rates_channel_active_idx" ON "provider_rates"("channel", "active");

-- AlterTable
ALTER TABLE "usage_rating_snapshots" ADD COLUMN "rate_micro_paise" BIGINT;
ALTER TABLE "usage_rating_snapshots" ADD COLUMN "provider_cost_micro_paise" BIGINT;
ALTER TABLE "usage_rating_snapshots" ADD COLUMN "markup_amount_micro_paise" BIGINT;
ALTER TABLE "usage_rating_snapshots" ADD COLUMN "retail_amount_micro_paise" BIGINT;

-- Backfill existing snapshots to preserve exact 1:1 micro-paise representation
UPDATE "usage_rating_snapshots"
SET "provider_cost_micro_paise" = "provider_cost_paise" * 1000000,
    "markup_amount_micro_paise" = "markup_amount_paise" * 1000000,
    "retail_amount_micro_paise" = "customer_charge_paise" * 1000000
WHERE "provider_cost_micro_paise" IS NULL;
