-- CreateTable
CREATE TABLE "call_shadow_rating_conflicts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "shadow_rating_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "incoming_values" JSONB NOT NULL,
    "existing_values" JSONB NOT NULL,
    "detected_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_shadow_rating_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_shadow_rating_conflicts_tenant_id_detected_at_idx" ON "call_shadow_rating_conflicts"("tenant_id", "detected_at" DESC);

-- CreateIndex
CREATE INDEX "call_shadow_rating_conflicts_call_id_idx" ON "call_shadow_rating_conflicts"("call_id");

-- CreateIndex
CREATE INDEX "call_shadow_rating_conflicts_shadow_rating_id_idx" ON "call_shadow_rating_conflicts"("shadow_rating_id");

-- AddForeignKey
ALTER TABLE "call_shadow_rating_conflicts" ADD CONSTRAINT "call_shadow_rating_conflicts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_shadow_rating_conflicts" ADD CONSTRAINT "call_shadow_rating_conflicts_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_shadow_rating_conflicts" ADD CONSTRAINT "call_shadow_rating_conflicts_shadow_rating_id_fkey" FOREIGN KEY ("shadow_rating_id") REFERENCES "call_shadow_ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
