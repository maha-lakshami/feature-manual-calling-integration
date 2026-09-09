-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended', 'pending');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('super_admin', 'manager', 'staff');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('invited', 'active', 'revoked');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('whatsapp', 'email', 'call');

-- CreateEnum
CREATE TYPE "UsageEventType" AS ENUM ('whatsapp_message', 'email_message', 'ai_call_minute');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('topup_credit', 'free_credit_grant', 'usage_debit', 'free_credit_debit', 'adjustment', 'refund');

-- CreateEnum
CREATE TYPE "BalanceBucket" AS ENUM ('paid', 'free');

-- CreateEnum
CREATE TYPE "LowBalanceBehavior" AS ENUM ('hard_stop', 'soft_limit');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('held', 'confirmed', 'released');

-- CreateEnum
CREATE TYPE "RazorpayOrderStatus" AS ENUM ('created', 'attempted', 'paid', 'failed');

-- CreateEnum
CREATE TYPE "RazorpayPaymentStatus" AS ENUM ('captured', 'authorized', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'scheduled', 'queued', 'sending', 'completed', 'completed_with_failures', 'halted_insufficient_funds', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('pending', 'queued', 'sent', 'delivered', 'read', 'opened', 'clicked', 'failed', 'bounced', 'skipped_opted_out', 'skipped_insufficient_funds');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'paused');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('queued', 'initiated', 'ringing', 'in_progress', 'summarizing', 'completed', 'no_answer', 'busy', 'failed', 'escalated');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('resolved', 'follow_up_required', 'escalated_to_human', 'not_interested', 'unreachable', 'unknown');

-- CreateEnum
CREATE TYPE "TranscriptSpeaker" AS ENUM ('agent', 'customer', 'system');

-- CreateEnum
CREATE TYPE "CommunicationEventType" AS ENUM ('whatsapp_sent', 'whatsapp_delivered', 'whatsapp_read', 'whatsapp_failed', 'whatsapp_inbound', 'email_sent', 'email_delivered', 'email_opened', 'email_clicked', 'email_bounced', 'call_placed', 'call_completed', 'call_failed', 'call_escalated', 'contact_opted_out', 'contact_opted_in');

-- CreateEnum
CREATE TYPE "EventDirection" AS ENUM ('outbound', 'inbound', 'system');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "contact_email" TEXT,
    "staff_can_launch_campaigns" BOOLEAN NOT NULL DEFAULT false,
    "staff_can_trigger_calls" BOOLEAN NOT NULL DEFAULT false,
    "low_balance_behavior" "LowBalanceBehavior" NOT NULL DEFAULT 'hard_stop',
    "soft_limit_paise" BIGINT NOT NULL DEFAULT 0,
    "low_balance_threshold_paise" BIGINT NOT NULL DEFAULT 10000,
    "email_from_name" TEXT,
    "email_from_address" TEXT,
    "whatsapp_phone_number_id" TEXT,
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'staff',
    "invite_status" "InviteStatus" NOT NULL DEFAULT 'invited',
    "invited_by" UUID,
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "whatsapp_opted_in" BOOLEAN NOT NULL DEFAULT false,
    "email_opted_in" BOOLEAN NOT NULL DEFAULT true,
    "opted_out_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "balance_paise" BIGINT NOT NULL DEFAULT 0,
    "free_credit_balance_paise" BIGINT NOT NULL DEFAULT 0,
    "reserved_paise" BIGINT NOT NULL DEFAULT 0,
    "lifetime_credited_paise" BIGINT NOT NULL DEFAULT 0,
    "lifetime_debited_paise" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "bucket" "BalanceBucket" NOT NULL DEFAULT 'paid',
    "amount_paise" BIGINT NOT NULL,
    "balance_after_paise" BIGINT NOT NULL,
    "description" TEXT NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "idempotency_key" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'held',
    "reference_type" TEXT,
    "reference_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "settled_amount_paise" BIGINT,
    "confirmed_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "release_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "razorpay_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "razorpay_order_id" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "RazorpayOrderStatus" NOT NULL DEFAULT 'created',
    "receipt" TEXT,
    "notes" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "razorpay_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "razorpay_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID,
    "razorpay_payment_id" TEXT NOT NULL,
    "razorpay_order_id" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "RazorpayPaymentStatus" NOT NULL,
    "method" TEXT,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "credited_at" TIMESTAMP(3),
    "wallet_transaction_id" UUID,
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "razorpay_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "event_type" "UsageEventType" NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" "UsageEventType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_paise" BIGINT NOT NULL,
    "total_charge_paise" BIGINT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "bucket" "BalanceBucket" NOT NULL DEFAULT 'paid',
    "contact_id" UUID,
    "campaign_id" UUID,
    "call_id" UUID,
    "wallet_transaction_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'draft',
    "language" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "provider_template_name" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "template_id" UUID,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "estimated_cost_paise" BIGINT NOT NULL DEFAULT 0,
    "actual_cost_paise" BIGINT NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "destination" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'pending',
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cost_paise" BIGINT,
    "queued_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "clicked_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "direction" "CallDirection" NOT NULL DEFAULT 'outbound',
    "status" "CallStatus" NOT NULL DEFAULT 'queued',
    "outcome" "CallOutcome",
    "provider_call_id" TEXT,
    "from_number" TEXT NOT NULL,
    "to_number" TEXT NOT NULL,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "billed_minutes" INTEGER NOT NULL DEFAULT 0,
    "cost_paise" BIGINT,
    "recording_key" TEXT,
    "recording_duration_seconds" INTEGER,
    "summary" TEXT,
    "next_action" TEXT,
    "script_id" TEXT,
    "prompt_version" TEXT,
    "objective" TEXT,
    "escalated_at" TIMESTAMP(3),
    "escalation_reason" TEXT,
    "failure_reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_transcript_turns" (
    "id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "speaker" "TranscriptSpeaker" NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "at_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_transcript_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "event_type" "CommunicationEventType" NOT NULL,
    "direction" "EventDirection" NOT NULL DEFAULT 'outbound',
    "summary" TEXT NOT NULL,
    "campaign_id" UUID,
    "call_id" UUID,
    "provider_reference" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_type" TEXT,
    "provider_event_id" TEXT,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "duplicate" BOOLEAN NOT NULL DEFAULT false,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_is_super_admin_idx" ON "users"("is_super_admin");

-- CreateIndex
CREATE INDEX "tenant_users_tenant_id_role_idx" ON "tenant_users"("tenant_id", "role");

-- CreateIndex
CREATE INDEX "tenant_users_user_id_idx" ON "tenant_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_users_tenant_id_user_id_key" ON "tenant_users"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_created_at_idx" ON "contacts"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_full_name_idx" ON "contacts"("tenant_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_tenant_id_phone_key" ON "contacts"("tenant_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_tenant_id_email_key" ON "contacts"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_tenant_id_key" ON "wallets"("tenant_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_tenant_id_created_at_idx" ON "wallet_transactions"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "wallet_transactions_tenant_id_type_idx" ON "wallet_transactions"("tenant_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_tenant_id_idempotency_key_key" ON "wallet_transactions"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_reservations_tenant_id_status_idx" ON "wallet_reservations"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_reservations_tenant_id_idempotency_key_key" ON "wallet_reservations"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "razorpay_orders_razorpay_order_id_key" ON "razorpay_orders"("razorpay_order_id");

-- CreateIndex
CREATE INDEX "razorpay_orders_tenant_id_created_at_idx" ON "razorpay_orders"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "razorpay_payments_razorpay_payment_id_key" ON "razorpay_payments"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX "razorpay_payments_tenant_id_created_at_idx" ON "razorpay_payments"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "razorpay_payments_razorpay_order_id_idx" ON "razorpay_payments"("razorpay_order_id");

-- CreateIndex
CREATE INDEX "pricing_rules_tenant_id_event_type_active_idx" ON "pricing_rules"("tenant_id", "event_type", "active");

-- CreateIndex
CREATE INDEX "pricing_rules_event_type_active_idx" ON "pricing_rules"("event_type", "active");

-- CreateIndex
CREATE INDEX "usage_events_tenant_id_occurred_at_idx" ON "usage_events"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "usage_events_tenant_id_event_type_occurred_at_idx" ON "usage_events"("tenant_id", "event_type", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_tenant_id_idempotency_key_key" ON "usage_events"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "templates_tenant_id_channel_status_idx" ON "templates"("tenant_id", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "templates_tenant_id_name_channel_key" ON "templates"("tenant_id", "name", "channel");

-- CreateIndex
CREATE INDEX "campaigns_tenant_id_created_at_idx" ON "campaigns"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "campaigns_tenant_id_status_idx" ON "campaigns"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "campaign_recipients_provider_message_id_idx" ON "campaign_recipients"("provider_message_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_tenant_id_campaign_id_status_idx" ON "campaign_recipients"("tenant_id", "campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_contact_id_key" ON "campaign_recipients"("campaign_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "calls_provider_call_id_key" ON "calls"("provider_call_id");

-- CreateIndex
CREATE INDEX "calls_tenant_id_created_at_idx" ON "calls"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "calls_tenant_id_status_idx" ON "calls"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "calls_tenant_id_contact_id_idx" ON "calls"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "call_transcript_turns_call_id_sequence_idx" ON "call_transcript_turns"("call_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "call_transcript_turns_call_id_sequence_key" ON "call_transcript_turns"("call_id", "sequence");

-- CreateIndex
CREATE INDEX "communication_events_tenant_id_contact_id_occurred_at_idx" ON "communication_events"("tenant_id", "contact_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "communication_events_tenant_id_occurred_at_idx" ON "communication_events"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "communication_events_tenant_id_channel_occurred_at_idx" ON "communication_events"("tenant_id", "channel", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_provider_received_at_idx" ON "webhook_deliveries"("provider", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_provider_provider_event_id_key" ON "webhook_deliveries"("provider", "provider_event_id");

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "razorpay_orders" ADD CONSTRAINT "razorpay_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "razorpay_payments" ADD CONSTRAINT "razorpay_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "razorpay_payments" ADD CONSTRAINT "razorpay_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "razorpay_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_transcript_turns" ADD CONSTRAINT "call_transcript_turns_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_events" ADD CONSTRAINT "communication_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_events" ADD CONSTRAINT "communication_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_events" ADD CONSTRAINT "communication_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_events" ADD CONSTRAINT "communication_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

