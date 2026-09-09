-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('PROVIDER_API', 'PROVIDER_USAGE', 'RATE_CATALOG', 'ESTIMATE');

-- CreateTable
CREATE TABLE "usage_rating_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_reference" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "provider_cost_paise" BIGINT NOT NULL,
    "markup_bps" INTEGER NOT NULL,
    "markup_amount_paise" BIGINT NOT NULL,
    "customer_charge_paise" BIGINT NOT NULL,
    "cost_source" "CostSource" NOT NULL,
    "policy_reference" TEXT,
    "usage_reference" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "rated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_rating_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_rating_snapshots_tenant_id_usage_reference_key" ON "usage_rating_snapshots"("tenant_id", "usage_reference");

-- CreateIndex
CREATE INDEX "usage_rating_snapshots_tenant_id_channel_settled_at_idx" ON "usage_rating_snapshots"("tenant_id", "channel", "settled_at" DESC);

-- CreateIndex
CREATE INDEX "usage_rating_snapshots_provider_settled_at_idx" ON "usage_rating_snapshots"("provider", "settled_at" DESC);

-- AddForeignKey
ALTER TABLE "usage_rating_snapshots" ADD CONSTRAINT "usage_rating_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
