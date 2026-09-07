import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  calculateVarianceBps,
  Channel,
  CostSource,
  DEFAULT_MARKUP_BPS,
  RecipientStatus,
  type WhatsAppCampaignActivationReadinessDto,
  type WhatsAppCampaignShadowReconciliationDto,
  type WhatsAppShadowRatingDto,
} from '@aiking/shared';
import type {
  WhatsAppCampaignShadowReconciliation,
  WhatsAppShadowRating,
} from '@prisma/client';

import { isUniqueViolation, PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { RatingEngineService } from '../billing/rating-engine.service';
import { RateCatalogService } from '../rate-catalog/rate-catalog.service';

export interface RateRecipientSafelyInput {
  readonly campaignRecipientId: string;
}

export type WhatsAppShadowRatingResult =
  | {
      readonly recorded: true;
      readonly isDuplicate: boolean;
      readonly conflict?: false;
      readonly shadowRating: WhatsAppShadowRatingDto;
    }
  | {
      readonly recorded: false;
      readonly isDuplicate?: boolean;
      readonly conflict?: boolean;
      readonly reason: string;
      readonly message: string;
      readonly shadowRating?: WhatsAppShadowRatingDto;
    };

interface LatestShadowRatingRow {
  id: string;
  tenantId: string;
  campaignId: string;
  campaignRecipientId: string;
  ratingVersion: number;
  status: string;
  billable: boolean | null;
  providerCostMicroPaise: bigint | null;
  rateMicroPaise: bigint | null;
  legacyCustomerChargePaise: bigint;
}

/**
 * Service managing observational WhatsApp Shadow Rating & Campaign Reconciliation (Phase 5).
 *
 * Invariants:
 * - Scoped strictly via trusted ALS tenantContext.requireTenantId().
 * - Loads CampaignRecipient from DB under tenant scope to derive provider, destination, providerMessageId, category, and occurredAt.
 * - WhatsAppShadowRating.provider is nullable:
 *     - RATED -> provider required
 *     - provider-based COST_UNAVAILABLE / CATEGORY_UNAVAILABLE -> provider required
 *     - PROVIDER_UNKNOWN -> provider must remain null
 * - Missing sentAt: fails closed and persists auditable INVALID_STATE (SENT_AT_MISSING) with occurredAt = null; never fabricates timestamps.
 * - Non-billable path supported: if provider reports billable=false, records NON_BILLABLE with 0 provider cost.
 * - Never defaults Meta category: missing category resolves generic rate or marks CATEGORY_UNAVAILABLE.
 * - Per-recipient granularity: exact micro-paise wholesale rate (1 message = rateMicroPaise).
 * - Campaign reconciliation: aggregates wholesale micro-paise, applies markup once, rounds once to customer paise.
 * - Equal-population reconciliation: economically resolved recipients = RATED + NON_BILLABLE.
 *   reconciliationEligibleRecipients defines the authoritative send/billing denominator.
 * - Persisted shadow rows and reconciliation versions are immutable.
 * - Version idempotency & concurrency: serialized via PostgreSQL advisory lock on tenantId + campaignId.
 *   Repeated identical reconciliation snapshots return existing version without allocating duplicates.
 * - Activation readiness requires latest reconciliation isFinal = true AND durable conflicts = 0.
 * - Zero wallet or ledger mutation.
 */
@Injectable()
export class WhatsAppShadowRatingService {
  private readonly logger = new Logger(WhatsAppShadowRatingService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly rateCatalog: RateCatalogService,
    private readonly ratingEngine: RatingEngineService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Safely execute shadow rating for a delivered/sent WhatsApp message recipient.
   * Never throws to the caller: logs any unhandled exceptions and returns fail-closed result.
   */
  async rateRecipientSafely(campaignRecipientId: string): Promise<WhatsAppShadowRatingResult> {
    try {
      return await this.executeShadowRating(campaignRecipientId);
    } catch (error) {
      this.logger.error(
        `Unexpected failure during WhatsApp shadow rating for recipient ${campaignRecipientId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return {
        recorded: false,
        reason: 'UNEXPECTED_ERROR',
        message: (error as Error).message,
      };
    }
  }

  private async executeShadowRating(campaignRecipientId: string): Promise<WhatsAppShadowRatingResult> {
    const tenantId = this.tenantContext.requireTenantId('WhatsAppShadowRatingService.rateRecipient');
    const lockKey = `${tenantId}:${campaignRecipientId}`;

    return this.prisma.$transaction(async (tx) => {
      // 1. Transaction-scoped PostgreSQL advisory lock per tenant + recipient ensures concurrency serialization
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recipient_shadow_rating'), hashtext(${lockKey}))`;

      // 2. Load CampaignRecipient row under trusted tenant context
      const recipient = await tx.campaignRecipient.findUnique({
        where: { id: campaignRecipientId },
        include: {
          campaign: { select: { id: true, channel: true } },
        },
      });

      if (!recipient || recipient.tenantId !== tenantId) {
        this.logger.warn(`Recipient ${campaignRecipientId} not found in tenant ${tenantId} during shadow rating`);
        return {
          recorded: false,
          reason: 'RECIPIENT_NOT_FOUND',
          message: `Recipient ${campaignRecipientId} not found`,
        };
      }

      if (recipient.campaign.channel !== Channel.WHATSAPP) {
        this.logger.warn(`Recipient ${campaignRecipientId} is channel ${recipient.campaign.channel}, not WHATSAPP`);
        return {
          recorded: false,
          reason: 'CHANNEL_MISMATCH',
          message: `Recipient belongs to channel ${recipient.campaign.channel}`,
        };
      }

      // 3. Authoritative occurredAt timestamp: sentAt. Fail closed if missing without timestamp fabrication.
      const occurredAt = recipient.sentAt ?? null;
      const provider = recipient.provider ?? null;
      const providerMessageId = recipient.providerMessageId ?? null;
      const destination = recipient.destination;
      const category = recipient.providerCategory ?? null;
      const pricingModel = recipient.providerPricingModel ?? null;
      // Invariant: Do NOT assume missing provider billing evidence means billable.
      // - providerBillable === false -> NON_BILLABLE
      // - providerBillable === true  -> billable provider evidence
      // - providerBillable === null  -> missing evidence -> COST_UNAVAILABLE (BILLABLE_SIGNAL_MISSING)
      const billable = recipient.providerBillable ?? null;
      const legacyCustomerChargePaise = recipient.costPaise ?? 0n;

      const resolveProviderRate = async (originProvider: string) => {
        let resolved = await this.rateCatalog.resolveRate({
          provider: originProvider,
          channel: Channel.WHATSAPP,
          destination,
          category,
          unit: 'message',
          currency: 'INR',
          occurredAt: occurredAt!,
        });

        if (!resolved && destination?.startsWith('+')) {
          resolved = await this.rateCatalog.resolveRate({
            provider: originProvider,
            channel: Channel.WHATSAPP,
            destination: destination.slice(1),
            category,
            unit: 'message',
            currency: 'INR',
            occurredAt: occurredAt!,
          });
        }

        return resolved;
      };

      let recoveredRate: Awaited<ReturnType<typeof resolveProviderRate>> = null;

      // 4. Find latest existing shadow rating row for this recipient
      const latest = await tx.whatsAppShadowRating.findFirst({
        where: { tenantId, campaignRecipientId: recipient.id },
        orderBy: { ratingVersion: 'desc' },
      });

      if (latest) {
        const occurredMatches =
          (latest.occurredAt === null && occurredAt === null) ||
          (latest.occurredAt !== null &&
            occurredAt !== null &&
            latest.occurredAt.getTime() === occurredAt.getTime());

        const isIdentical =
          latest.provider === provider &&
          latest.providerMessageId === providerMessageId &&
          latest.destination === destination &&
          latest.category === category &&
          latest.billable === billable &&
          latest.legacyCustomerChargePaise === legacyCustomerChargePaise &&
          occurredMatches;

        const canRetryRateCatalog =
          latest.status === 'COST_UNAVAILABLE' &&
          latest.unavailableReason === 'RATE_NOT_CONFIGURED' &&
          provider !== null &&
          occurredAt !== null &&
          billable === true;

        if (isIdentical && canRetryRateCatalog) {
          recoveredRate = await resolveProviderRate(provider);
        }

        if (isIdentical && !recoveredRate) {
          this.logger.debug(`Idempotent WhatsApp shadow rating replay for recipient ${recipient.id}`);
          return {
            recorded: true,
            isDuplicate: true,
            conflict: false,
            shadowRating: this.toShadowRatingDto(latest),
          };
        }

        // Check for contradictory conflict vs expected enrichment
        const isBillableConflict =
          latest.billable !== null &&
          billable !== null &&
          latest.billable !== billable;

        const isProviderConflict =
          latest.provider !== null &&
          provider !== null &&
          latest.provider !== provider;

        const isMessageIdConflict =
          latest.providerMessageId !== null &&
          providerMessageId !== null &&
          latest.providerMessageId !== providerMessageId;

        const isDestinationConflict = latest.destination !== destination;

        const isLegacyChargeConflict = latest.legacyCustomerChargePaise !== legacyCustomerChargePaise;

        const isOccurredAtConflict =
          latest.occurredAt !== null &&
          occurredAt !== null &&
          latest.occurredAt.getTime() !== occurredAt.getTime();

        const isRegressionConflict =
          (latest.status === 'RATED' || latest.status === 'NON_BILLABLE') &&
          billable === null;

        const isConflict =
          isBillableConflict ||
          isProviderConflict ||
          isMessageIdConflict ||
          isDestinationConflict ||
          isLegacyChargeConflict ||
          isOccurredAtConflict ||
          isRegressionConflict;

        if (isConflict) {
          this.logger.warn(
            `RECONCILIATION_CONFLICT detected on shadow rating for recipient ${recipient.id}: ` +
              `existing v${latest.ratingVersion} (provider=${latest.provider}, billable=${latest.billable}, dest=${latest.destination}) ` +
              `vs incoming (provider=${provider}, billable=${billable}, dest=${destination}). Original row left unmutated.`,
          );

          // Persist durable conflict record to append-only audit table.
          // Original WhatsAppShadowRating row remains untouched and immutable.
          await tx.whatsAppShadowRatingConflict.create({
            data: {
              tenantId,
              campaignRecipientId: recipient.id,
              shadowRatingId: latest.id,
              reason: 'RECONCILIATION_CONFLICT',
              existingValues: {
                ratingVersion: latest.ratingVersion,
                status: latest.status,
                provider: latest.provider,
                providerMessageId: latest.providerMessageId,
                destination: latest.destination,
                category: latest.category,
                billable: latest.billable,
                legacyCustomerChargePaise: latest.legacyCustomerChargePaise.toString(),
                occurredAt: latest.occurredAt?.toISOString() ?? null,
              },
              incomingValues: {
                provider,
                providerMessageId,
                destination,
                category,
                billable,
                legacyCustomerChargePaise: legacyCustomerChargePaise.toString(),
                occurredAt: occurredAt?.toISOString() ?? null,
              },
            },
          });

          return {
            recorded: false,
            isDuplicate: true,
            conflict: true,
            reason: 'RECONCILIATION_CONFLICT',
            message: 'Replay parameters conflict with existing immutable shadow rating record',
            shadowRating: this.toShadowRatingDto(latest),
          };
        }

        this.logger.log(
          `Expected provider enrichment detected for recipient ${recipient.id}: appending ratingVersion ${latest.ratingVersion + 1}`,
        );
      }

      const nextRatingVersion = latest ? latest.ratingVersion + 1 : 1;

      // 5. Evaluate shadow rating status and values
      // 5a. Missing sentAt: fails closed and persists auditable INVALID_STATE (SENT_AT_MISSING)
      if (!occurredAt) {
        this.logger.error(
          `Recipient ${recipient.id} is missing authoritative sentAt timestamp; recording INVALID_STATE (SENT_AT_MISSING)`,
        );
        return this.persistShadowRow(tx, {
          tenantId,
          campaignId: recipient.campaignId,
          campaignRecipientId: recipient.id,
          ratingVersion: nextRatingVersion,
          provider,
          providerMessageId,
          destination,
          category,
          pricingModel,
          billable,
          rateMicroPaise: null,
          providerCostMicroPaise: null,
          legacyCustomerChargePaise,
          status: 'INVALID_STATE',
          unavailableReason: 'SENT_AT_MISSING',
          costSource: null,
          providerRateId: null,
          policyReference: null,
          occurredAt: null,
        });
      }

      // 5b. Missing provider: records PROVIDER_UNKNOWN
      if (!provider || !provider.trim()) {
        this.logger.warn(`Recipient ${recipient.id} has no known originating provider; recording PROVIDER_UNKNOWN`);
        return this.persistShadowRow(tx, {
          tenantId,
          campaignId: recipient.campaignId,
          campaignRecipientId: recipient.id,
          ratingVersion: nextRatingVersion,
          provider: null,
          providerMessageId,
          destination,
          category,
          pricingModel,
          billable,
          rateMicroPaise: null,
          providerCostMicroPaise: null,
          legacyCustomerChargePaise,
          status: 'PROVIDER_UNKNOWN',
          unavailableReason: 'RECIPIENT_PROVIDER_MISSING',
          costSource: null,
          providerRateId: null,
          policyReference: null,
          occurredAt,
        });
      }

      // 5c. Missing provider billability signal (providerBillable === null): COST_UNAVAILABLE
      if (billable === null) {
        this.logger.warn(
          `Recipient ${recipient.id} is missing provider billability signal; recording COST_UNAVAILABLE (BILLABLE_SIGNAL_MISSING)`,
        );
        return this.persistShadowRow(tx, {
          tenantId,
          campaignId: recipient.campaignId,
          campaignRecipientId: recipient.id,
          ratingVersion: nextRatingVersion,
          provider,
          providerMessageId,
          destination,
          category,
          pricingModel,
          billable: null,
          rateMicroPaise: null,
          providerCostMicroPaise: null,
          legacyCustomerChargePaise,
          status: 'COST_UNAVAILABLE',
          unavailableReason: 'BILLABLE_SIGNAL_MISSING',
          costSource: null,
          providerRateId: null,
          policyReference: null,
          occurredAt,
        });
      }

      // 5d. Authoritative non-billable signal (billable === false): NON_BILLABLE
      if (billable === false) {
        this.logger.debug(`Recipient ${recipient.id} marked non-billable by provider; recording NON_BILLABLE`);
        return this.persistShadowRow(tx, {
          tenantId,
          campaignId: recipient.campaignId,
          campaignRecipientId: recipient.id,
          ratingVersion: nextRatingVersion,
          provider,
          providerMessageId,
          destination,
          category,
          pricingModel,
          billable: false,
          rateMicroPaise: 0n,
          providerCostMicroPaise: 0n,
          legacyCustomerChargePaise,
          status: 'NON_BILLABLE',
          unavailableReason: null,
          costSource: null,
          providerRateId: null,
          policyReference: null,
          occurredAt,
        });
      }

      // 5e. Authoritative billable signal (billable === true) -> Resolve wholesale rate
      const rate = recoveredRate ?? (await resolveProviderRate(provider));

      if (!rate) {
        const isMissingCategory = !category;
        const status = isMissingCategory ? 'CATEGORY_UNAVAILABLE' : 'COST_UNAVAILABLE';
        const unavailableReason = isMissingCategory
          ? 'CATEGORY_MISSING_AND_NO_GENERIC_RATE'
          : 'RATE_NOT_CONFIGURED';

        this.logger.warn(
          `Wholesale rate unavailable for recipient ${recipient.id} on ${provider}:WhatsApp ` +
            `(dest=${destination}, category=${category}, reason=${unavailableReason})`,
        );

        return this.persistShadowRow(tx, {
          tenantId,
          campaignId: recipient.campaignId,
          campaignRecipientId: recipient.id,
          ratingVersion: nextRatingVersion,
          provider,
          providerMessageId,
          destination,
          category,
          pricingModel,
          billable: true,
          rateMicroPaise: null,
          providerCostMicroPaise: null,
          legacyCustomerChargePaise,
          status,
          unavailableReason,
          costSource: null,
          providerRateId: null,
          policyReference: null,
          occurredAt,
        });
      }

      // 5f. Successful resolution (RATED)
      const rateMicroPaise = rate.rateMicroPaise;
      const providerCostMicroPaise = rateMicroPaise;

      return this.persistShadowRow(tx, {
        tenantId,
        campaignId: recipient.campaignId,
        campaignRecipientId: recipient.id,
        ratingVersion: nextRatingVersion,
        provider,
        providerMessageId,
        destination,
        category,
        pricingModel,
        billable: true,
        rateMicroPaise,
        providerCostMicroPaise,
        legacyCustomerChargePaise,
        status: 'RATED',
        unavailableReason: null,
        costSource: CostSource.RATE_CATALOG,
        providerRateId: rate.id,
        policyReference: `ProviderRate:${rate.id}:v${rate.version}`,
        occurredAt,
      });
    });
  }

  private async persistShadowRow(
    tx: any,
    data: {
      tenantId: string;
      campaignId: string;
      campaignRecipientId: string;
      ratingVersion: number;
      provider: string | null;
      providerMessageId: string | null;
      destination: string;
      category: string | null;
      pricingModel: string | null;
      billable: boolean | null;
      rateMicroPaise: bigint | null;
      providerCostMicroPaise: bigint | null;
      legacyCustomerChargePaise: bigint;
      status: string;
      unavailableReason: string | null;
      costSource: CostSource | null;
      providerRateId: string | null;
      policyReference: string | null;
      occurredAt: Date | null;
    },
  ): Promise<WhatsAppShadowRatingResult> {
    try {
      const created = await tx.whatsAppShadowRating.create({
        data: {
          tenantId: data.tenantId,
          campaignId: data.campaignId,
          campaignRecipientId: data.campaignRecipientId,
          ratingVersion: data.ratingVersion,
          provider: data.provider,
          providerMessageId: data.providerMessageId,
          destination: data.destination,
          category: data.category,
          pricingModel: data.pricingModel,
          billable: data.billable,
          rateMicroPaise: data.rateMicroPaise,
          providerCostMicroPaise: data.providerCostMicroPaise,
          legacyCustomerChargePaise: data.legacyCustomerChargePaise,
          status: data.status,
          unavailableReason: data.unavailableReason,
          costSource: data.costSource,
          providerRateId: data.providerRateId,
          policyReference: data.policyReference,
          occurredAt: data.occurredAt,
          ratedAt: new Date(),
        },
      });

      this.logger.log(
        `Recorded WhatsApp shadow rating v${data.ratingVersion} for recipient ${data.campaignRecipientId} (${data.status}) in tenant ${data.tenantId}`,
      );

      return {
        recorded: true,
        isDuplicate: false,
        shadowRating: this.toShadowRatingDto(created),
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Concurrent insert won the race; load latest for this recipient & version
        const existing = await tx.whatsAppShadowRating.findFirst({
          where: {
            tenantId: data.tenantId,
            campaignRecipientId: data.campaignRecipientId,
            ratingVersion: data.ratingVersion,
          },
        });
        if (existing) {
          return {
            recorded: true,
            isDuplicate: true,
            shadowRating: this.toShadowRatingDto(existing),
          };
        }
      }
      throw error;
    }
  }

  /**
   * Reconcile an entire WhatsApp campaign's shadow ratings at the campaign level.
   *
   * Safeguards (Phase 5):
   * 1. ELIGIBLE POPULATION:
   *    - Determines reconciliationEligibleRecipients as recipients reaching authoritative send/billing stage.
   *    - Ineligible/pre-send skips (opted-out, insufficient funds, pre-send failed) do not block reconciliation.
   *    - isFinal means all reconciliation-eligible recipients are economically resolved.
   * 2. VERSION IDEMPOTENCY + CONCURRENCY:
   *    - Transaction-scoped PostgreSQL advisory lock serializes writers by tenantId + campaignId.
   *    - Computes current reconciliation state.
   *    - Loads latest version and compares immutable snapshot values.
   *    - If unchanged: returns existing version without allocating duplicate version.
   *    - If changed: appends latestVersion + 1.
   * 3. NON_BILLABLE ACCOUNTING:
   *    - NON_BILLABLE is economically resolved.
   *    - providerCostMicroPaise = 0.
   *    - Its legacy customer charge is included in ratedLegacyTotalPaise (resolved legacy total).
   * 4. FINANCIAL AGGREGATION:
   *    - Single-pass wholesale micro-paise sum across economically resolved population.
   *    - Applies 25% markup once, rounds once to paise.
   */
  async reconcileCampaign(campaignId: string): Promise<WhatsAppCampaignShadowReconciliationDto> {
    const tenantId = this.tenantContext.requireTenantId('WhatsAppShadowRatingService.reconcileCampaign');
    const lockKey = `${tenantId}:${campaignId}`;

    return this.prisma.$transaction(async (tx) => {
      // 1. Transaction-scoped PostgreSQL advisory lock serializes concurrent workers per tenant + campaign
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('campaign_reconciliation'), hashtext(${lockKey}))`;

      const campaign = await tx.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, tenantId: true, channel: true },
      });

      if (!campaign || campaign.tenantId !== tenantId) {
        throw new Error(`Campaign ${campaignId} not found in tenant ${tenantId}`);
      }

      const totalRecipients = await tx.campaignRecipient.count({
        where: { campaignId, tenantId },
      });

      // Safeguard 1: Exact reconciliation-eligible population
      // Recipients that reached the authoritative send/billing stage requiring economic comparison
      const eligibleRecipients = await tx.campaignRecipient.count({
        where: {
          campaignId,
          tenantId,
          OR: [
            {
              status: {
                in: [
                  RecipientStatus.SENT,
                  RecipientStatus.DELIVERED,
                  RecipientStatus.READ,
                  RecipientStatus.OPENED,
                  RecipientStatus.CLICKED,
                ],
              },
            },
            {
              status: { in: [RecipientStatus.FAILED, RecipientStatus.BOUNCED] },
              sentAt: { not: null },
            },
          ],
        },
      });

      // Query latest recipient rating version strictly once using PostgreSQL DISTINCT ON
      const latestRatings = await tx.$queryRaw<LatestShadowRatingRow[]>`
        SELECT DISTINCT ON (campaign_recipient_id)
          id,
          tenant_id AS "tenantId",
          campaign_id AS "campaignId",
          campaign_recipient_id AS "campaignRecipientId",
          rating_version AS "ratingVersion",
          status,
          billable,
          provider_cost_micro_paise AS "providerCostMicroPaise",
          rate_micro_paise AS "rateMicroPaise",
          legacy_customer_charge_paise AS "legacyCustomerChargePaise"
        FROM whatsapp_shadow_ratings
        WHERE campaign_id = ${campaignId}::uuid AND tenant_id = ${tenantId}::uuid
        ORDER BY campaign_recipient_id, rating_version DESC
      `;

      const rated = latestRatings.filter((r) => r.status === 'RATED');
      const nonBillable = latestRatings.filter((r) => r.status === 'NON_BILLABLE');
      const ratedRecipients = rated.length;
      const nonBillableRecipients = nonBillable.length;
      const economicallyResolvedRecipients = ratedRecipients + nonBillableRecipients;
      const unratedRecipients =
        eligibleRecipients > economicallyResolvedRecipients
          ? eligibleRecipients - economicallyResolvedRecipients
          : 0;

      let totalProviderCostMicroPaise = 0n;
      let resolvedLegacyTotalPaise = 0n;

      for (const r of rated) {
        if (r.providerCostMicroPaise != null) {
          totalProviderCostMicroPaise += BigInt(r.providerCostMicroPaise);
        }
        resolvedLegacyTotalPaise += BigInt(r.legacyCustomerChargePaise);
      }

      for (const r of nonBillable) {
        // Safeguard 5: NON_BILLABLE is economically resolved. Provider cost is 0.
        // Legacy charge is included in resolvedLegacyTotalPaise.
        resolvedLegacyTotalPaise += BigInt(r.legacyCustomerChargePaise);
      }

      // Safeguard 6: BigInt-only aggregation reusing Phase 3 RatingEngineService
      // providerCostMicroPaise = SUM(exact resolved recipient provider costs)
      // markupAmountMicroPaise = ceil(providerCostMicroPaise * markupBps / 10_000)
      // retailAmountMicroPaise = providerCostMicroPaise + markupAmountMicroPaise
      // shadowCustomerChargePaise = ceil(retailAmountMicroPaise / 1_000_000)
      // For zero cost: shadowCustomerChargePaise = 0n
      const markupBps = DEFAULT_MARKUP_BPS; // 2500 bps (25.00%)
      const ratedCharge = this.ratingEngine.calculateMicroPaise(
        totalProviderCostMicroPaise,
        'INR',
        markupBps,
      );
      const markupAmountMicroPaise = ratedCharge.markupAmountMicroPaise ?? 0n;
      const retailAmountMicroPaise = ratedCharge.retailAmountMicroPaise ?? totalProviderCostMicroPaise;
      const ratedShadowTotalPaise = ratedCharge.customerChargePaise;
      const signedDifferencePaise = ratedShadowTotalPaise - resolvedLegacyTotalPaise;
      const rawVarianceBps = calculateVarianceBps(signedDifferencePaise, resolvedLegacyTotalPaise);
      const varianceBps =
        rawVarianceBps > 2_147_483_647
          ? 2_147_483_647
          : rawVarianceBps < -2_147_483_648
            ? -2_147_483_648
            : rawVarianceBps;

      // Safeguard 4: isFinal means all reconciliation-eligible recipients have an authoritative economic state
      const isFinal = eligibleRecipients > 0 && economicallyResolvedRecipients >= eligibleRecipients;

      let status = 'UNAVAILABLE';
      if (isFinal) {
        status = 'COMPLETE';
      } else if (economicallyResolvedRecipients > 0) {
        status = 'PARTIAL';
      }

      // Safeguard 2: Load latest version and compare immutable snapshot values
      const latest = await tx.whatsAppCampaignShadowReconciliation.findFirst({
        where: { tenantId, campaignId },
        orderBy: { version: 'desc' },
      });

      if (latest) {
        const isUnchanged =
          latest.totalRecipients === totalRecipients &&
          latest.eligibleRecipients === eligibleRecipients &&
          latest.ratedRecipients === ratedRecipients &&
          latest.unratedRecipients === unratedRecipients &&
          latest.nonBillableRecipients === nonBillableRecipients &&
          latest.totalProviderCostMicroPaise === totalProviderCostMicroPaise &&
          latest.markupBps === markupBps &&
          latest.markupAmountMicroPaise === markupAmountMicroPaise &&
          latest.retailAmountMicroPaise === retailAmountMicroPaise &&
          latest.ratedLegacyTotalPaise === resolvedLegacyTotalPaise &&
          latest.ratedShadowTotalPaise === ratedShadowTotalPaise &&
          latest.signedDifferencePaise === signedDifferencePaise &&
          latest.varianceBps === varianceBps &&
          latest.status === status &&
          latest.isFinal === isFinal;

        if (isUnchanged) {
          this.logger.debug(
            `Campaign reconciliation for ${campaignId} v${latest.version} is unchanged; returning existing snapshot`,
          );
          return this.toCampaignReconciliationDto(latest);
        }
      }

      const nextVersion = latest ? latest.version + 1 : 1;

      const created = await tx.whatsAppCampaignShadowReconciliation.create({
        data: {
          tenantId,
          campaignId,
          version: nextVersion,
          isFinal,
          totalRecipients,
          eligibleRecipients,
          ratedRecipients,
          unratedRecipients,
          nonBillableRecipients,
          totalProviderCostMicroPaise,
          markupBps,
          markupAmountMicroPaise,
          retailAmountMicroPaise,
          ratedLegacyTotalPaise: resolvedLegacyTotalPaise,
          ratedShadowTotalPaise,
          signedDifferencePaise,
          varianceBps,
          status,
          ratedAt: new Date(),
        },
      });

      this.logger.log(
        `Reconciled WhatsApp campaign ${campaignId} v${nextVersion}: ${status} (isFinal=${isFinal}, ` +
          `${economicallyResolvedRecipients}/${eligibleRecipients} eligible resolved, diff=${signedDifferencePaise}p, variance=${varianceBps}bps)`,
      );

      return this.toCampaignReconciliationDto(created);
    });
  }

  /**
   * Fetch existing shadow rating record for a recipient if it exists.
   */
  async getShadowRatingForRecipient(campaignRecipientId: string): Promise<WhatsAppShadowRatingDto | null> {
    const tenantId = this.tenantContext.requireTenantId('WhatsAppShadowRatingService.getShadowRatingForRecipient');
    const rating = await this.prisma.whatsAppShadowRating.findFirst({
      where: {
        tenantId,
        campaignRecipientId,
      },
      orderBy: { ratingVersion: 'desc' },
    });
    return rating ? this.toShadowRatingDto(rating) : null;
  }

  /**
   * Fetch latest existing campaign shadow reconciliation if it exists, optionally by version.
   */
  async getCampaignReconciliation(
    campaignId: string,
    version?: number,
  ): Promise<WhatsAppCampaignShadowReconciliationDto | null> {
    const tenantId = this.tenantContext.requireTenantId('WhatsAppShadowRatingService.getCampaignReconciliation');
    const reconciliation = await this.prisma.whatsAppCampaignShadowReconciliation.findFirst({
      where: {
        tenantId,
        campaignId,
        ...(version !== undefined ? { version } : {}),
      },
      orderBy: { version: 'desc' },
    });
    return reconciliation ? this.toCampaignReconciliationDto(reconciliation) : null;
  }

  /**
   * Evaluates activation readiness for a WhatsApp campaign.
   *
   * Invariants (Safeguard 4):
   * Activation readiness strictly requires:
   * 1. Latest reconciliation isFinal = true (all reconciliation-eligible recipients have authoritative economic state)
   * 2. Durable reconciliation conflicts = 0
   */
  async evaluateCampaignActivationReadiness(
    campaignId: string,
  ): Promise<WhatsAppCampaignActivationReadinessDto> {
    const tenantId = this.tenantContext.requireTenantId(
      'WhatsAppShadowRatingService.evaluateCampaignActivationReadiness',
    );

    const latestReconciliation = await this.prisma.whatsAppCampaignShadowReconciliation.findFirst({
      where: { tenantId, campaignId },
      orderBy: { version: 'desc' },
    });

    const conflictCount = await this.prisma.whatsAppShadowRatingConflict.count({
      where: {
        tenantId,
        recipient: { campaignId },
      },
    });

    const blockingReasons: string[] = [];

    if (!latestReconciliation) {
      blockingReasons.push('No reconciliation snapshot exists for this campaign.');
    } else if (!latestReconciliation.isFinal) {
      blockingReasons.push(
        `Latest reconciliation (v${latestReconciliation.version}, ${latestReconciliation.status}) is not final: ` +
          `${latestReconciliation.unratedRecipients} eligible recipients remain unresolved.`,
      );
    }

    if (conflictCount > 0) {
      blockingReasons.push(`Durable reconciliation conflicts detected: ${conflictCount}`);
    }

    const ready = latestReconciliation !== null && latestReconciliation.isFinal && conflictCount === 0;

    return {
      campaignId,
      ready,
      isFinal: latestReconciliation?.isFinal ?? false,
      reconciliationVersion: latestReconciliation?.version ?? null,
      reconciliationStatus: latestReconciliation?.status ?? null,
      eligibleRecipients: latestReconciliation?.eligibleRecipients ?? 0,
      economicallyResolvedRecipients:
        latestReconciliation
          ? latestReconciliation.ratedRecipients + latestReconciliation.nonBillableRecipients
          : 0,
      conflictCount,
      blockingReasons,
      evaluatedAt: new Date().toISOString(),
    };
  }

  toShadowRatingDto(entity: WhatsAppShadowRating): WhatsAppShadowRatingDto {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      campaignId: entity.campaignId,
      campaignRecipientId: entity.campaignRecipientId,
      ratingVersion: entity.ratingVersion,
      provider: entity.provider,
      providerMessageId: entity.providerMessageId,
      destination: entity.destination,
      category: entity.category,
      pricingModel: entity.pricingModel,
      billable: entity.billable,
      rateMicroPaise: entity.rateMicroPaise !== null ? entity.rateMicroPaise.toString() : null,
      providerCostMicroPaise:
        entity.providerCostMicroPaise !== null ? entity.providerCostMicroPaise.toString() : null,
      legacyCustomerChargePaise: entity.legacyCustomerChargePaise.toString(),
      status: entity.status,
      unavailableReason: entity.unavailableReason,
      costSource: entity.costSource as CostSource | null,
      providerRateId: entity.providerRateId,
      policyReference: entity.policyReference,
      occurredAt: entity.occurredAt ? entity.occurredAt.toISOString() : null,
      ratedAt: entity.ratedAt.toISOString(),
      createdAt: entity.createdAt.toISOString(),
    };
  }

  toCampaignReconciliationDto(
    entity: WhatsAppCampaignShadowReconciliation,
  ): WhatsAppCampaignShadowReconciliationDto {
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
      nonBillableRecipients: entity.nonBillableRecipients,
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
