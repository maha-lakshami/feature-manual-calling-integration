import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  calculateVarianceBps,
  Channel,
  CostSource,
  DEFAULT_MARKUP_BPS,
  type EmailCampaignShadowReconciliationDto,
  type EmailShadowRatingDto,
} from '@aiking/shared';
import type { EmailCampaignShadowReconciliation, EmailShadowRating } from '@prisma/client';

import { isUniqueViolation, PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { RatingEngineService } from '../billing/rating-engine.service';
import { RateCatalogService } from '../rate-catalog/rate-catalog.service';

const EMAIL_QUANTITY = 1;
const EMAIL_UNIT = 'email';
const EMAIL_DESTINATION = '*';

export type EmailShadowRatingResult =
  | { readonly recorded: true; readonly isDuplicate: boolean; readonly shadowRating: EmailShadowRatingDto }
  | {
      readonly recorded: false;
      readonly isDuplicate?: boolean;
      readonly conflict?: boolean;
      readonly reason: string;
      readonly message: string;
      readonly shadowRating?: EmailShadowRatingDto;
    };

interface LatestEmailRatingRow {
  campaignRecipientId: string;
  status: string;
  providerCostMicroPaise: bigint | null;
  legacyCustomerChargePaise: bigint | null;
}

/**
 * Phase 6 observational Email provider-cost rating.
 *
 * It never mutates wallets, usage events, campaigns, or operational delivery state.
 * The only economic timestamp is the already-persisted CampaignRecipient.sentAt.
 */
@Injectable()
export class EmailShadowRatingService {
  private readonly logger = new Logger(EmailShadowRatingService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly rateCatalog: RateCatalogService,
    private readonly ratingEngine: RatingEngineService,
    private readonly tenantContext: TenantContext,
  ) {}

  async rateRecipientSafely(campaignRecipientId: string): Promise<EmailShadowRatingResult> {
    try {
      return await this.rateRecipient(campaignRecipientId);
    } catch (error) {
      this.logger.error(
        `Unexpected Email shadow-rating failure for recipient ${campaignRecipientId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return { recorded: false, reason: 'UNEXPECTED_ERROR', message: (error as Error).message };
    }
  }

  async rateRecipient(campaignRecipientId: string): Promise<EmailShadowRatingResult> {
    const tenantId = this.tenantContext.requireTenantId('EmailShadowRatingService.rateRecipient');
    const lockKey = `${tenantId}:${campaignRecipientId}`;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('email_recipient_shadow_rating'), hashtext(${lockKey}))`;

      const recipient = await tx.campaignRecipient.findUnique({
        where: { id: campaignRecipientId },
        include: { campaign: { select: { id: true, channel: true } } },
      });

      if (!recipient || recipient.tenantId !== tenantId) {
        return { recorded: false, reason: 'RECIPIENT_NOT_FOUND', message: `Recipient ${campaignRecipientId} not found` };
      }
      if (recipient.campaign.channel !== Channel.EMAIL) {
        return {
          recorded: false,
          reason: 'CHANNEL_MISMATCH',
          message: `Recipient belongs to channel ${recipient.campaign.channel}`,
        };
      }

      const provider = recipient.provider?.trim() || null;
      const providerMessageId = recipient.providerMessageId ?? null;
      const destination = recipient.destination;
      const occurredAt = recipient.sentAt ?? null;
      const legacyCustomerChargePaise = recipient.costPaise ?? null;

      const resolveProviderRate = (originProvider: string) =>
        this.rateCatalog.resolveRate({
          provider: originProvider,
          channel: Channel.EMAIL,
          destination: EMAIL_DESTINATION,
          category: null,
          unit: EMAIL_UNIT,
          currency: 'INR',
          occurredAt: occurredAt!,
        });

      let recoveredRate: Awaited<ReturnType<typeof resolveProviderRate>> = null;
      const latest = await tx.emailShadowRating.findFirst({
        where: { tenantId, campaignRecipientId: recipient.id },
        orderBy: { ratingVersion: 'desc' },
      });

      if (latest) {
        const occurredMatches =
          (latest.occurredAt === null && occurredAt === null) ||
          (latest.occurredAt !== null && occurredAt !== null && latest.occurredAt.getTime() === occurredAt.getTime());
        const identical =
          latest.provider === provider &&
          latest.providerMessageId === providerMessageId &&
          latest.destination === destination &&
          latest.quantity === EMAIL_QUANTITY &&
          latest.unit === EMAIL_UNIT &&
          latest.legacyCustomerChargePaise === legacyCustomerChargePaise &&
          occurredMatches;

        // RATE_NOT_CONFIGURED is recoverable evidence, not a terminal duplicate.
        // Re-check the catalog before returning the unchanged v1 row.
        const canRecoverRate =
          identical &&
          latest.status === 'COST_UNAVAILABLE' &&
          latest.unavailableReason === 'RATE_NOT_CONFIGURED' &&
          provider !== null &&
          occurredAt !== null &&
          providerMessageId !== null &&
          legacyCustomerChargePaise !== null;
        if (canRecoverRate) recoveredRate = await resolveProviderRate(provider);

        if (identical && !recoveredRate) {
          return { recorded: true, isDuplicate: true, shadowRating: this.toShadowRatingDto(latest) };
        }

        const conflict =
          (latest.provider !== null && provider !== null && latest.provider !== provider) ||
          (latest.providerMessageId !== null && providerMessageId !== null && latest.providerMessageId !== providerMessageId) ||
          latest.destination !== destination ||
          latest.quantity !== EMAIL_QUANTITY ||
          latest.unit !== EMAIL_UNIT ||
          (latest.legacyCustomerChargePaise !== null &&
            legacyCustomerChargePaise !== null &&
            latest.legacyCustomerChargePaise !== legacyCustomerChargePaise) ||
          (latest.occurredAt !== null && occurredAt !== null && latest.occurredAt.getTime() !== occurredAt.getTime()) ||
          (latest.status === 'RATED' &&
            (provider === null || providerMessageId === null || occurredAt === null || legacyCustomerChargePaise === null));

        if (conflict) {
          await tx.emailShadowRatingConflict.create({
            data: {
              tenantId,
              campaignRecipientId: recipient.id,
              shadowRatingId: latest.id,
              reason: 'RECONCILIATION_CONFLICT',
              existingValues: this.evidenceJson(latest),
              incomingValues: {
                provider,
                providerMessageId,
                destination,
                quantity: EMAIL_QUANTITY,
                unit: EMAIL_UNIT,
                legacyCustomerChargePaise: legacyCustomerChargePaise?.toString() ?? null,
                occurredAt: occurredAt?.toISOString() ?? null,
              },
            },
          });
          return {
            recorded: false,
            isDuplicate: true,
            conflict: true,
            reason: 'RECONCILIATION_CONFLICT',
            message: 'Incoming evidence contradicts the latest immutable Email shadow rating',
            shadowRating: this.toShadowRatingDto(latest),
          };
        }
      }

      const base = {
        tenantId,
        campaignId: recipient.campaignId,
        campaignRecipientId: recipient.id,
        ratingVersion: (latest?.ratingVersion ?? 0) + 1,
        provider,
        providerMessageId,
        destination,
        quantity: EMAIL_QUANTITY,
        unit: EMAIL_UNIT,
        legacyCustomerChargePaise,
        occurredAt,
      };

      if (!occurredAt) {
        return this.persist(tx, { ...base, status: 'INVALID_STATE', unavailableReason: 'SENT_AT_MISSING' });
      }
      if (!provider) {
        return this.persist(tx, { ...base, status: 'PROVIDER_UNKNOWN', unavailableReason: 'RECIPIENT_PROVIDER_MISSING' });
      }
      if (!providerMessageId) {
        return this.persist(tx, { ...base, status: 'INVALID_STATE', unavailableReason: 'PROVIDER_MESSAGE_ID_MISSING' });
      }
      if (legacyCustomerChargePaise === null) {
        return this.persist(tx, { ...base, status: 'INVALID_STATE', unavailableReason: 'LEGACY_CHARGE_MISSING' });
      }

      const rate = recoveredRate ?? (await resolveProviderRate(provider));
      if (!rate) {
        return this.persist(tx, { ...base, status: 'COST_UNAVAILABLE', unavailableReason: 'RATE_NOT_CONFIGURED' });
      }

      const providerCostMicroPaise = rate.rateMicroPaise * BigInt(EMAIL_QUANTITY);
      return this.persist(tx, {
        ...base,
        status: 'RATED',
        unavailableReason: null,
        rateMicroPaise: rate.rateMicroPaise,
        providerCostMicroPaise,
        costSource: CostSource.RATE_CATALOG,
        providerRateId: rate.id,
        policyReference: `ProviderRate:${rate.id}:v${rate.version}`,
      });
    });
  }

  private async persist(tx: any, input: any): Promise<EmailShadowRatingResult> {
    try {
      const created = await tx.emailShadowRating.create({
        data: {
          ...input,
          rateMicroPaise: input.rateMicroPaise ?? null,
          providerCostMicroPaise: input.providerCostMicroPaise ?? null,
          costSource: input.costSource ?? null,
          providerRateId: input.providerRateId ?? null,
          policyReference: input.policyReference ?? null,
          ratedAt: new Date(),
        },
      });
      return { recorded: true, isDuplicate: false, shadowRating: this.toShadowRatingDto(created) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await tx.emailShadowRating.findFirst({
          where: {
            tenantId: input.tenantId,
            campaignRecipientId: input.campaignRecipientId,
            ratingVersion: input.ratingVersion,
          },
        });
        if (existing) return { recorded: true, isDuplicate: true, shadowRating: this.toShadowRatingDto(existing) };
      }
      throw error;
    }
  }

  async reconcileCampaign(campaignId: string): Promise<EmailCampaignShadowReconciliationDto> {
    const tenantId = this.tenantContext.requireTenantId('EmailShadowRatingService.reconcileCampaign');
    const lockKey = `${tenantId}:${campaignId}`;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('email_campaign_reconciliation'), hashtext(${lockKey}))`;
      const campaign = await tx.campaign.findUnique({
        where: { id: campaignId },
        select: { tenantId: true, channel: true },
      });
      if (!campaign || campaign.tenantId !== tenantId || campaign.channel !== Channel.EMAIL) {
        throw new Error(`Email campaign ${campaignId} not found in tenant ${tenantId}`);
      }

      const totalRecipients = await tx.campaignRecipient.count({ where: { tenantId, campaignId } });
      // Any persisted acceptance/settlement evidence enters the denominator; partial rows stay visible as gaps.
      const eligibleRecipients = await tx.campaignRecipient.count({
        where: {
          tenantId,
          campaignId,
          OR: [{ sentAt: { not: null } }, { providerMessageId: { not: null } }, { costPaise: { not: null } }],
        },
      });

      const latestRatings = await tx.$queryRaw<LatestEmailRatingRow[]>`
        SELECT DISTINCT ON (campaign_recipient_id)
          rating.campaign_recipient_id AS "campaignRecipientId",
          rating.status,
          rating.provider_cost_micro_paise AS "providerCostMicroPaise",
          rating.legacy_customer_charge_paise AS "legacyCustomerChargePaise"
        FROM email_shadow_ratings AS rating
        INNER JOIN campaign_recipients AS recipient
          ON recipient.id = rating.campaign_recipient_id
        WHERE rating.campaign_id = ${campaignId}::uuid
          AND rating.tenant_id = ${tenantId}::uuid
          AND (
            recipient.sent_at IS NOT NULL
            OR recipient.provider_message_id IS NOT NULL
            OR recipient.cost_paise IS NOT NULL
          )
        ORDER BY rating.campaign_recipient_id, rating.rating_version DESC
      `;
      const rated = latestRatings.filter(
        (row) => row.status === 'RATED' && row.providerCostMicroPaise !== null && row.legacyCustomerChargePaise !== null,
      );
      const ratedRecipients = rated.length;
      const unratedRecipients = eligibleRecipients > ratedRecipients ? eligibleRecipients - ratedRecipients : 0;

      let totalProviderCostMicroPaise = 0n;
      let ratedLegacyTotalPaise = 0n;
      for (const row of rated) {
        totalProviderCostMicroPaise += row.providerCostMicroPaise!;
        ratedLegacyTotalPaise += row.legacyCustomerChargePaise!;
      }

      const markupBps = DEFAULT_MARKUP_BPS;
      const charge = this.ratingEngine.calculateMicroPaise(totalProviderCostMicroPaise, 'INR', markupBps);
      const markupAmountMicroPaise = charge.markupAmountMicroPaise ?? 0n;
      const retailAmountMicroPaise = charge.retailAmountMicroPaise ?? totalProviderCostMicroPaise;
      const ratedShadowTotalPaise = charge.customerChargePaise;
      const signedDifferencePaise = ratedShadowTotalPaise - ratedLegacyTotalPaise;
      const rawVarianceBps = calculateVarianceBps(signedDifferencePaise, ratedLegacyTotalPaise);
      const varianceBps = Math.max(-2_147_483_648, Math.min(2_147_483_647, rawVarianceBps));
      const isFinal = eligibleRecipients > 0 && ratedRecipients >= eligibleRecipients;
      const status = isFinal ? 'COMPLETE' : ratedRecipients > 0 ? 'PARTIAL' : 'UNAVAILABLE';

      const snapshot = {
        totalRecipients,
        eligibleRecipients,
        ratedRecipients,
        unratedRecipients,
        totalProviderCostMicroPaise,
        markupBps,
        markupAmountMicroPaise,
        retailAmountMicroPaise,
        ratedLegacyTotalPaise,
        ratedShadowTotalPaise,
        signedDifferencePaise,
        varianceBps,
        status,
        isFinal,
      };
      const latest = await tx.emailCampaignShadowReconciliation.findFirst({
        where: { tenantId, campaignId },
        orderBy: { version: 'desc' },
      });
      const unchanged =
        latest !== null &&
        latest.totalRecipients === totalRecipients &&
        latest.eligibleRecipients === eligibleRecipients &&
        latest.ratedRecipients === ratedRecipients &&
        latest.unratedRecipients === unratedRecipients &&
        latest.totalProviderCostMicroPaise === totalProviderCostMicroPaise &&
        latest.markupBps === markupBps &&
        latest.markupAmountMicroPaise === markupAmountMicroPaise &&
        latest.retailAmountMicroPaise === retailAmountMicroPaise &&
        latest.ratedLegacyTotalPaise === ratedLegacyTotalPaise &&
        latest.ratedShadowTotalPaise === ratedShadowTotalPaise &&
        latest.signedDifferencePaise === signedDifferencePaise &&
        latest.varianceBps === varianceBps &&
        latest.status === status &&
        latest.isFinal === isFinal;
      if (unchanged) {
        return this.toReconciliationDto(latest);
      }

      const created = await tx.emailCampaignShadowReconciliation.create({
        data: { tenantId, campaignId, version: (latest?.version ?? 0) + 1, ...snapshot, ratedAt: new Date() },
      });
      return this.toReconciliationDto(created);
    });
  }

  private evidenceJson(rating: EmailShadowRating): Record<string, string | number | null> {
    return {
      ratingVersion: rating.ratingVersion,
      status: rating.status,
      provider: rating.provider,
      providerMessageId: rating.providerMessageId,
      destination: rating.destination,
      quantity: rating.quantity,
      unit: rating.unit,
      legacyCustomerChargePaise: rating.legacyCustomerChargePaise?.toString() ?? null,
      occurredAt: rating.occurredAt?.toISOString() ?? null,
    };
  }

  toShadowRatingDto(entity: EmailShadowRating): EmailShadowRatingDto {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      campaignId: entity.campaignId,
      campaignRecipientId: entity.campaignRecipientId,
      ratingVersion: entity.ratingVersion,
      provider: entity.provider,
      providerMessageId: entity.providerMessageId,
      destination: entity.destination,
      quantity: entity.quantity,
      unit: entity.unit,
      rateMicroPaise: entity.rateMicroPaise?.toString() ?? null,
      providerCostMicroPaise: entity.providerCostMicroPaise?.toString() ?? null,
      legacyCustomerChargePaise: entity.legacyCustomerChargePaise?.toString() ?? null,
      status: entity.status,
      unavailableReason: entity.unavailableReason,
      costSource: entity.costSource as CostSource | null,
      providerRateId: entity.providerRateId,
      policyReference: entity.policyReference,
      occurredAt: entity.occurredAt?.toISOString() ?? null,
      ratedAt: entity.ratedAt.toISOString(),
      createdAt: entity.createdAt.toISOString(),
    };
  }

  private toReconciliationDto(entity: EmailCampaignShadowReconciliation): EmailCampaignShadowReconciliationDto {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      campaignId: entity.campaignId,
      version: entity.version,
      isFinal: entity.isFinal,
      totalRecipients: entity.totalRecipients,
      eligibleRecipients: entity.eligibleRecipients,
      ratedRecipients: entity.ratedRecipients,
      unratedRecipients: entity.unratedRecipients,
      totalProviderCostMicroPaise: entity.totalProviderCostMicroPaise.toString(),
      markupBps: entity.markupBps,
      markupAmountMicroPaise: entity.markupAmountMicroPaise.toString(),
      retailAmountMicroPaise: entity.retailAmountMicroPaise.toString(),
      ratedLegacyTotalPaise: entity.ratedLegacyTotalPaise.toString(),
      ratedShadowTotalPaise: entity.ratedShadowTotalPaise.toString(),
      signedDifferencePaise: entity.signedDifferencePaise.toString(),
      varianceBps: entity.varianceBps,
      status: entity.status,
      ratedAt: entity.ratedAt.toISOString(),
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
