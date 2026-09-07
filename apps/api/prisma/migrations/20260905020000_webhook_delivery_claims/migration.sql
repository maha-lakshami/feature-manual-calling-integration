-- AlterTable
ALTER TABLE "webhook_deliveries"
ADD COLUMN "processing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "processing_started_at" TIMESTAMP(3);