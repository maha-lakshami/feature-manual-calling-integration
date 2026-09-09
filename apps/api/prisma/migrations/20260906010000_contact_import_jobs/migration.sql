CREATE TABLE "contact_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "object_key" TEXT NOT NULL,
    "unknown_columns_as_custom_fields" BOOLEAN NOT NULL DEFAULT true,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "error_summary" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "contact_imports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contact_imports_tenant_id_created_at_idx" ON "contact_imports"("tenant_id", "created_at");

ALTER TABLE "contact_imports" ADD CONSTRAINT "contact_imports_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
