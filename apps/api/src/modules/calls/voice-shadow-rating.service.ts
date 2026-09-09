import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Channel,
  CostSource,
  DEFAULT_MARKUP_BPS,
  paiseToMicroPaise,
  type CallShadowRatingDto,
} from '@aiking/shared';
import type { CallShadowRating } from '@prisma/client';

import { isUniqueViolation, PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { CostRegistryService } from '../../providers/cost/cost-registry.service';
import { RatingEngineService } from '../billing/rating-engine.service';

export interface RateCallSafelyInput {
  readonly callId: string;
  readonly billDurationSeconds?: number;
  readonly legacyCostPaise: bigint;
}

export type VoiceShadowRatingResult =
  | {
      readonly recorded: true;
      readonly isDuplicate: boolean;
      readonly conflict?: false;
      readonly shadowRating: CallShadowRatingDto;
    }
  | {
      readonly recorded: false;
      readonly isDuplicate?: boolean;
      readonly conflict?: boolean;
      readonly reason: string;
      readonly message: string;
      readonly shadowRating?: CallShadowRatingDto;
    };

/**
 * Service managing observational Voice Shadow Rating (Phase 4).
 *
 * Invariants:
 * - Scoped strictly via trusted ALS tenantContext.requireTenantId().
 * - Loads Call from DB under tenant scope to derive provider, destination, providerReference, and endedAt.
 * - CallShadowRating.provider is nullable:
 *     - RATED -> provider required
 *     - provider-based COST_UNAVAILABLE -> provider required
 *     - PROVIDER_UNKNOWN -> provider must remain null
 * - Stable occurredAt: requires persisted call.endedAt; never uses fallbacks to now or createdAt.
 * - Zero-usage / release path supported: if billDurationSeconds is missing or <= 0,
 *   records USAGE_NOT_FOUND while preserving authoritative legacyCustomerChargePaise.
 * - Reuses RatingEngineService.calculateMicroPaise for exact ceiling markup and retail charge.
 * - Persisted shadow rows are immutable: duplicate replays with identical values return existing;
 *   conflicting values log RECONCILIATION_CONFLICT and leave the original row unmutated.
 * - Zero wallet or ledger mutation.
 */
@Injectable()
export class VoiceShadowRatingService {
  private readonly logger = new Logger(VoiceShadowRatingService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly costRegistry: CostRegistryService,
    private readonly ratingEngine: RatingEngineService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Safely execute shadow rating for a completed voice call.
   * Never throws to the caller: logs any unhandled exceptions and returns fail-closed result.
   */
  async rateCallSafely(input: RateCallSafelyInput): Promise<VoiceShadowRatingResult> {
    try {
      return await this.executeShadowRating(input);
    } catch (error) {
      this.logger.error(
        `Unexpected failure during voice shadow rating for call ${input.callId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return {
        recorded: false,
        reason: 'UNEXPECTED_ERROR',
        message: (error as Error).message,
      };
    }
  }

  private async executeShadowRating(input: RateCallSafelyInput): Promise<VoiceShadowRatingResult> {
    const tenantId = this.tenantContext.requireTenantId('VoiceShadowRatingService.rateCall');

    // 1. Load Call row under trusted tenant context
    const call = await this.prisma.call.findUnique({
      where: { id: input.callId },
    });

    if (!call || call.tenantId !== tenantId) {
      this.logger.warn(`Call ${input.callId} not found in tenant ${tenantId} during shadow rating`);
      return {
        recorded: false,
        reason: 'CALL_NOT_FOUND',
        message: `Call ${input.callId} not found`,
      };
    }

    // 2. Authoritative endedAt timestamp check — NO timestamp fallbacks
    if (!call.endedAt) {
      this.logger.error(`Call ${call.id} is missing authoritative endedAt timestamp; cannot shadow rate`);
      return {
        recorded: false,
        reason: 'INVALID_CALL_STATE',
        message: 'Call is missing authoritative endedAt timestamp',
      };
    }
    const occurredAt = call.endedAt;

    const provider = call.provider ?? null;
    const providerReference = call.providerCallId ?? null;
    const billableSeconds = input.billDurationSeconds ?? null;

    // 3. Check for existing shadow rating row by (tenantId, callId)
    const existing = await this.prisma.callShadowRating.findUnique({
      where: {
        call_shadow_ratings_tenant_call_unique: {
          tenantId,
          callId: call.id,
        },
      },
    });

    if (existing) {
      const matches =
        existing.provider === provider &&
        existing.providerReference === providerReference &&
        existing.billableSeconds === billableSeconds &&
        existing.legacyCustomerChargePaise === input.legacyCostPaise &&
        existing.occurredAt.getTime() === occurredAt.getTime();

      if (matches) {
        this.logger.debug(`Idempotent shadow rating replay for call ${call.id}`);
        return {
          recorded: true,
          isDuplicate: true,
          conflict: false,
          shadowRating: this.toDto(existing),
        };
      }

      this.logger.warn(
        `RECONCILIATION_CONFLICT detected on duplicate shadow rating for call ${call.id}: ` +
          `original (provider=${existing.provider}, sec=${existing.billableSeconds}, legacy=${existing.legacyCustomerChargePaise}) ` +
          `vs replay (provider=${provider}, sec=${billableSeconds}, legacy=${input.legacyCostPaise}). Original row left unmutated.`,
      );

      // Persist durable conflict record to append-only audit table (Phase 4.1).
      // Original CallShadowRating row remains untouched and immutable.
      await this.prisma.callShadowRatingConflict.create({
        data: {
          tenantId,
          callId: call.id,
          shadowRatingId: existing.id,
          reason: 'RECONCILIATION_CONFLICT',
          existingValues: {
            provider: existing.provider,
            providerReference: existing.providerReference,
            billableSeconds: existing.billableSeconds,
            legacyCustomerChargePaise: existing.legacyCustomerChargePaise.toString(),
            occurredAt: existing.occurredAt.toISOString(),
          },
          incomingValues: {
            provider,
            providerReference,
            billableSeconds,
            legacyCustomerChargePaise: input.legacyCostPaise.toString(),
            occurredAt: occurredAt.toISOString(),
          },
        },
      });

      return {
        recorded: false,
        isDuplicate: true,
        conflict: true,
        reason: 'RECONCILIATION_CONFLICT',
        message: 'Replay parameters conflict with existing immutable shadow rating record',
        shadowRating: this.toDto(existing),
      };
    }

    // 4. Invariant: If provider is unknown, fail closed with PROVIDER_UNKNOWN and provider = null
    if (!provider || !provider.trim()) {
      this.logger.warn(`Call ${call.id} has no known originating provider; recording PROVIDER_UNKNOWN`);
      return this.persistShadowRow({
        tenantId,
        callId: call.id,
        provider: null,
        providerReference,
        billableSeconds,
        legacyCustomerChargePaise: input.legacyCostPaise,
        status: 'PROVIDER_UNKNOWN',
        unavailableReason: 'ORIGINATING_PROVIDER_UNKNOWN',
        occurredAt,
      });
    }

    // 5. Invariant: If billDurationSeconds is missing or <= 0, record USAGE_NOT_FOUND (zero-usage / released call)
    if (billableSeconds === null || billableSeconds <= 0) {
      this.logger.debug(
        `Call ${call.id} carried no authoritative billable duration (${billableSeconds}s); recording USAGE_NOT_FOUND`,
      );
      return this.persistShadowRow({
        tenantId,
        callId: call.id,
        provider,
        providerReference,
        billableSeconds,
        legacyCustomerChargePaise: input.legacyCostPaise,
        status: 'USAGE_NOT_FOUND',
        unavailableReason: 'NO_BILLABLE_DURATION_REPORTED',
        occurredAt,
      });
    }

    // 6. Resolve wholesale provider cost via CostRegistryService
    const resolution = await this.costRegistry.resolveActualCost({
      tenantId,
      provider,
      channel: Channel.CALL,
      quantity: billableSeconds,
      unit: 'second',
      currency: 'INR',
      destination: call.toNumber,
      providerReference: providerReference ?? undefined,
      metadata: { occurredAt },
    });

    if (!resolution.available) {
      this.logger.warn(
        `Wholesale rate unavailable for provider "${provider}" on call ${call.id}: ${resolution.reason}`,
      );
      return this.persistShadowRow({
        tenantId,
        callId: call.id,
        provider,
        providerReference,
        billableSeconds,
        legacyCustomerChargePaise: input.legacyCostPaise,
        status: 'COST_UNAVAILABLE',
        unavailableReason: resolution.reason,
        occurredAt,
      });
    }

    // 7. Authoritative rating calculation reusing RatingEngineService.calculateMicroPaise
    const costMicroPaise =
      resolution.cost.costMicroPaise ?? paiseToMicroPaise(resolution.cost.costPaise);
    const policy = this.ratingEngine.resolvePolicy(tenantId, Channel.CALL);
    const markupBps = policy.markupBps ?? DEFAULT_MARKUP_BPS;

    const rated = this.ratingEngine.calculateMicroPaise(costMicroPaise, 'INR', markupBps);
    const shadowCustomerChargePaise = rated.customerChargePaise;
    const differencePaise = shadowCustomerChargePaise - input.legacyCostPaise;

    const providerRateId =
      resolution.cost.providerRateId ??
      (typeof resolution.cost.metadata?.rateId === 'string' ? resolution.cost.metadata.rateId : null);

    return this.persistShadowRow({
      tenantId,
      callId: call.id,
      provider,
      providerReference,
      billableSeconds,
      rateMicroPaise: resolution.cost.rateMicroPaise ?? null,
      providerCostMicroPaise: rated.providerCostMicroPaise,
      markupBps,
      markupAmountMicroPaise: rated.markupAmountMicroPaise,
      retailAmountMicroPaise: rated.retailAmountMicroPaise,
      legacyCustomerChargePaise: input.legacyCostPaise,
      shadowCustomerChargePaise,
      differencePaise,
      status: 'RATED',
      costSource: resolution.cost.source,
      providerRateId,
      policyReference: policy.policyReference ?? null,
      occurredAt,
    });
  }

  private async persistShadowRow(data: {
    tenantId: string;
    callId: string;
    provider: string | null;
    providerReference: string | null;
    billableSeconds: number | null;
    rateMicroPaise?: bigint | null;
    providerCostMicroPaise?: bigint | null;
    markupBps?: number | null;
    markupAmountMicroPaise?: bigint | null;
    retailAmountMicroPaise?: bigint | null;
    legacyCustomerChargePaise: bigint;
    shadowCustomerChargePaise?: bigint | null;
    differencePaise?: bigint | null;
    status: string;
    unavailableReason?: string | null;
    costSource?: CostSource | null;
    providerRateId?: string | null;
    policyReference?: string | null;
    occurredAt: Date;
  }): Promise<VoiceShadowRatingResult> {
    try {
      const created = await this.prisma.callShadowRating.create({
        data: {
          tenantId: data.tenantId,
          callId: data.callId,
          provider: data.provider,
          providerReference: data.providerReference,
          billableSeconds: data.billableSeconds,
          rateMicroPaise: data.rateMicroPaise ?? null,
          providerCostMicroPaise: data.providerCostMicroPaise ?? null,
          markupBps: data.markupBps ?? null,
          markupAmountMicroPaise: data.markupAmountMicroPaise ?? null,
          retailAmountMicroPaise: data.retailAmountMicroPaise ?? null,
          legacyCustomerChargePaise: data.legacyCustomerChargePaise,
          shadowCustomerChargePaise: data.shadowCustomerChargePaise ?? null,
          differencePaise: data.differencePaise ?? null,
          status: data.status,
          unavailableReason: data.unavailableReason ?? null,
          costSource: data.costSource ?? null,
          providerRateId: data.providerRateId ?? null,
          policyReference: data.policyReference ?? null,
          occurredAt: data.occurredAt,
        },
      });

      this.logger.log(
        `Shadow rating recorded for call ${data.callId}: status=${data.status}, ` +
          `shadow=${data.shadowCustomerChargePaise ?? 'N/A'} paise, legacy=${data.legacyCustomerChargePaise} paise, ` +
          `diff=${data.differencePaise ?? 'N/A'} paise`,
      );

      return {
        recorded: true,
        isDuplicate: false,
        conflict: false,
        shadowRating: this.toDto(created),
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Concurrency race: fetch the winner row and return safely
        const winner = await this.prisma.callShadowRating.findUniqueOrThrow({
          where: {
            call_shadow_ratings_tenant_call_unique: {
              tenantId: data.tenantId,
              callId: data.callId,
            },
          },
        });
        return {
          recorded: true,
          isDuplicate: true,
          conflict: false,
          shadowRating: this.toDto(winner),
        };
      }
      throw error;
    }
  }

  private toDto(entity: CallShadowRating): CallShadowRatingDto {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      callId: entity.callId,
      provider: entity.provider,
      providerReference: entity.providerReference,
      billableSeconds: entity.billableSeconds,
      rateMicroPaise: entity.rateMicroPaise,
      providerCostMicroPaise: entity.providerCostMicroPaise,
      markupBps: entity.markupBps,
      markupAmountMicroPaise: entity.markupAmountMicroPaise,
      retailAmountMicroPaise: entity.retailAmountMicroPaise,
      legacyCustomerChargePaise: entity.legacyCustomerChargePaise,
      shadowCustomerChargePaise: entity.shadowCustomerChargePaise,
      differencePaise: entity.differencePaise,
      status: entity.status,
      unavailableReason: entity.unavailableReason,
      costSource: entity.costSource as CostSource | null,
      providerRateId: entity.providerRateId,
      policyReference: entity.policyReference,
      occurredAt: entity.occurredAt.toISOString(),
      ratedAt: entity.ratedAt.toISOString(),
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
