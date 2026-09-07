import type { Channel } from './enums';

/**
 * Sources of provider cost data.
 *
 * Explicit classification ensures callers know whether a cost was authoritative
 * from an API call, from a reconciled CDR / usage event, from a pre-configured
 * rate sheet catalog, or an upfront estimate.
 */
export const CostSource = {
  PROVIDER_API: 'PROVIDER_API',
  PROVIDER_USAGE: 'PROVIDER_USAGE',
  RATE_CATALOG: 'RATE_CATALOG',
  ESTIMATE: 'ESTIMATE',
} as const;
export type CostSource = (typeof CostSource)[keyof typeof CostSource];

/** Reasons why authoritative provider cost could not be determined. */
export const CostUnavailableReason = {
  NOT_SUPPORTED_BY_PROVIDER: 'NOT_SUPPORTED_BY_PROVIDER',
  RATE_NOT_CONFIGURED: 'RATE_NOT_CONFIGURED',
  USAGE_NOT_FOUND: 'USAGE_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNSUPPORTED_CHANNEL: 'UNSUPPORTED_CHANNEL',
} as const;
export type CostUnavailableReason = (typeof CostUnavailableReason)[keyof typeof CostUnavailableReason];

/** Basis point denominator: 10,000 bps = 100%. */
export const BPS_DENOMINATOR = 10000n;

/** Micro-paise scale factor: 1 paisa = 1,000,000 micro-paise. */
export const MICRO_PAISE_FACTOR = 1000000n;

/**
 * Convert integer paise to micro-paise.
 */
export function paiseToMicroPaise(paise: bigint): bigint {
  return paise * MICRO_PAISE_FACTOR;
}

/**
 * Deterministic ceiling division from micro-paise to integer paise.
 */
export function microPaiseToPaiseCeil(microPaise: bigint): bigint {
  if (microPaise < 0n) {
    return microPaise / MICRO_PAISE_FACTOR;
  }
  return (microPaise + (MICRO_PAISE_FACTOR - 1n)) / MICRO_PAISE_FACTOR;
}

/**
 * Provider-neutral usage description passed to cost resolvers.
 */
export interface ProviderUsage {
  readonly tenantId: string;
  readonly channel: Channel;
  readonly quantity: number;
  readonly unit: string;
  readonly currency: string;
  readonly provider: string;
  readonly providerReference?: string;
  readonly destination?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Authoritative normalized wholesale cost from a provider.
 */
export interface NormalizedProviderCost {
  readonly provider: string;
  readonly channel: Channel;
  readonly quantity: number;
  readonly unit: string;
  readonly currency: string;
  readonly costPaise: bigint;
  readonly costMicroPaise?: bigint;
  readonly rateMicroPaise?: bigint;
  readonly providerRateId?: string;
  readonly source: CostSource;
  readonly calculatedAt: Date;
  readonly externalReference?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CallShadowRatingDto {
  readonly id: string;
  readonly tenantId: string;
  readonly callId: string;
  readonly provider: string | null;
  readonly providerReference: string | null;
  readonly billableSeconds: number | null;
  readonly rateMicroPaise: bigint | null;
  readonly providerCostMicroPaise: bigint | null;
  readonly markupBps: number | null;
  readonly markupAmountMicroPaise: bigint | null;
  readonly retailAmountMicroPaise: bigint | null;
  readonly legacyCustomerChargePaise: bigint;
  readonly shadowCustomerChargePaise: bigint | null;
  readonly differencePaise: bigint | null;
  readonly status: string;
  readonly unavailableReason: string | null;
  readonly costSource: CostSource | null;
  readonly providerRateId: string | null;
  readonly policyReference: string | null;
  readonly occurredAt: string;
  readonly ratedAt: string;
  readonly createdAt: string;
}

/**
 * Result of resolving a provider's cost.
 * Fail-closed union: when available is false, cost is never fabricated.
 */
export type ProviderCostResolution =
  | {
      readonly available: true;
      readonly cost: NormalizedProviderCost;
    }
  | {
      readonly available: false;
      readonly provider: string;
      readonly channel: Channel;
      readonly reason: CostUnavailableReason;
      readonly message?: string;
    };

/**
 * Pricing policy applied on top of normalized provider cost.
 * Basis points: 2500 bps = 25.00%.
 */
export interface PricingPolicy {
  readonly markupBps: number;
  readonly policyReference?: string;
}

/**
 * Default commercial markup: 25% (2500 bps).
 * Customer retail price = provider cost * 1.25.
 */
export const DEFAULT_MARKUP_BPS = 2500;

/**
 * Result of rating a usage event through the pricing engine.
 * Integer paise throughout, preserving exact micro-paise economics.
 */
export interface RatedCustomerCharge {
  readonly providerCostPaise: bigint;
  readonly markupBps: number;
  readonly markupAmountPaise: bigint;
  readonly customerChargePaise: bigint;
  readonly currency: string;
  readonly providerCostMicroPaise?: bigint;
  readonly markupAmountMicroPaise?: bigint;
  readonly retailAmountMicroPaise?: bigint;
}

/**
 * Wholesale provider rate entry DTO (Platform Scoped).
 */
export interface ProviderRateDto {
  readonly id: string;
  readonly provider: string;
  readonly channel: Channel;
  readonly destinationPattern: string;
  readonly category: string | null;
  readonly unit: string;
  readonly rateMicroPaise: string;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly active: boolean;
  readonly version: number;
  readonly description: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Immutable historical usage rating snapshot DTO.
 * Serializes BigInt fields to strings for safe wire transmission.
 */
export interface UsageRatingSnapshotDto {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: Channel;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly quantity: number;
  readonly unit: string;
  readonly currency: string;
  readonly rateMicroPaise?: string | null;
  readonly providerCostMicroPaise?: string | null;
  readonly markupAmountMicroPaise?: string | null;
  readonly retailAmountMicroPaise?: string | null;
  readonly providerCostPaise: string;
  readonly markupBps: number;
  readonly markupAmountPaise: string;
  readonly customerChargePaise: string;
  readonly costSource: CostSource;
  readonly policyReference: string | null;
  readonly usageReference: string;
  readonly metadata: Record<string, unknown>;
  readonly ratedAt: string;
  readonly settledAt: string;
  readonly createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4.1 Voice Shadow Reconciliation & Activation Gate Contracts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates relative variance in basis points (100 bps = 1.00%) using
 * deterministic signed integer division with symmetric half-away-from-zero rounding.
 * Zero denominator returns 0 without division.
 * Zero floating-point arithmetic.
 */
export function calculateVarianceBps(
  signedDiffPaise: bigint,
  ratedLegacyTotalPaise: bigint,
): number {
  if (ratedLegacyTotalPaise === 0n) return 0;
  const numerator = signedDiffPaise * 10_000n;
  const half = ratedLegacyTotalPaise / 2n;
  const rounded =
    numerator >= 0n
      ? (numerator + half) / ratedLegacyTotalPaise
      : (numerator - half) / ratedLegacyTotalPaise;
  return Number(rounded);
}

/**
 * Platform-wide or filtered voice shadow reconciliation summary.
 * All pricing variance totals and averages are derived strictly from RATED rows.
 */
export interface ReconciliationSummaryDto {
  readonly totalCallsEvaluated: number;
  readonly ratedCount: number;
  readonly costUnavailableCount: number;
  readonly usageNotFoundCount: number;
  readonly missingAuthoritativeBillDurationCount: number;
  readonly zeroAuthoritativeBillDurationCount: number;
  readonly usageNotFoundLegacyChargePaise: string;
  readonly providerUnknownCount: number;
  readonly conflictCount: number;

  // Strict RATED-only financial metrics
  readonly ratedLegacyTotalPaise: string;
  readonly ratedShadowTotalPaise: string;
  readonly signedDifferencePaise: string;
  readonly absoluteDifferencePaise: string;
  readonly minDifferencePaise: string;
  readonly maxDifferencePaise: string;
  readonly avgLegacyChargePaise: string;
  readonly avgShadowChargePaise: string;
  readonly varianceBps: number;
}

export type RateCoverageMatchType =
  | 'specific'
  | 'wildcard'
  | 'uncovered'
  | 'effective_date_gap'
  | 'unit_currency_mismatch';

export interface DestinationCoverageSummary {
  readonly destination: string;
  readonly totalCalls: number;
  readonly matchType: RateCoverageMatchType;
  readonly matchedRateId: string | null;
  readonly matchedPattern: string | null;
  readonly rateMicroPaise: string | null;
}

export interface RateCoverageReportDto {
  readonly provider: string;
  readonly totalDestinationsEvaluated: number;
  readonly specificMatchCount: number;
  readonly wildcardMatchCount: number;
  readonly uncoveredCount: number;
  readonly effectiveDateGapCount: number;
  readonly unitCurrencyMismatchCount: number;
  readonly destinations: readonly DestinationCoverageSummary[];
}

export interface ActivationGateThresholds {
  readonly maxConflictsAllowed?: number;
  readonly maxUnknownProvidersAllowed?: number;
  readonly minResolvedRateCoveragePercent?: number;
  readonly minSampleCount?: number;
}

export interface ActivationGateCheckItem {
  readonly name: string;
  readonly passed: boolean;
  readonly actual: string | number;
  readonly expected: string | number;
  readonly details?: string;
}

export interface ActivationGateReportDto {
  readonly status: 'READY_FOR_ACTIVATION_REVIEW' | 'NOT_READY';
  readonly passedChecks: number;
  readonly totalChecks: number;
  readonly checks: readonly ActivationGateCheckItem[];
  readonly blockingReasons: readonly string[];
  readonly evaluatedAt: string;
}

export interface LiveQueueHealthDto {
  readonly driver: 'bullmq' | 'inline';
  readonly isReady: boolean;
  readonly pendingJobs: number;
  readonly registeredQueues: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 WhatsApp Shadow Rating & Campaign Reconciliation Contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface WhatsAppShadowRatingDto {
  readonly id: string;
  readonly tenantId: string;
  readonly campaignId: string;
  readonly campaignRecipientId: string;
  readonly ratingVersion: number;
  readonly provider: string | null;
  readonly providerMessageId: string | null;
  readonly destination: string;
  readonly category: string | null;
  readonly pricingModel: string | null;
  readonly billable: boolean | null;
  readonly rateMicroPaise: string | null;
  readonly providerCostMicroPaise: string | null;
  readonly legacyCustomerChargePaise: string;
  readonly status: string;
  readonly unavailableReason: string | null;
  readonly costSource: CostSource | null;
  readonly providerRateId: string | null;
  readonly policyReference: string | null;
  readonly occurredAt: string | null;
  readonly ratedAt: string;
  readonly createdAt: string;
}

export interface WhatsAppCampaignShadowReconciliationDto {
  readonly id: string;
  readonly tenantId: string;
  readonly campaignId: string;
  readonly version: number;
  readonly isFinal: boolean;
  readonly totalRecipients: number;
  readonly eligibleRecipients: number;
  readonly ratedRecipients: number;
  readonly unratedRecipients: number;
  readonly nonBillableRecipients: number;
  readonly totalProviderCostMicroPaise: string;
  readonly markupBps: number;
  readonly markupAmountMicroPaise: string;
  readonly retailAmountMicroPaise: string;
  readonly ratedLegacyTotalPaise: string;
  readonly ratedShadowTotalPaise: string;
  readonly signedDifferencePaise: string;
  readonly varianceBps: number;
  readonly status: string;
  readonly ratedAt: string;
  readonly createdAt: string;
}

export interface WhatsAppShadowRatingConflictDto {
  readonly id: string;
  readonly tenantId: string;
  readonly campaignRecipientId: string;
  readonly shadowRatingId: string;
  readonly reason: string;
  readonly incomingValues: Record<string, unknown>;
  readonly existingValues: Record<string, unknown>;
  readonly detectedAt: string;
}

export interface WhatsAppCampaignActivationReadinessDto {
  readonly campaignId: string;
  readonly ready: boolean;
  readonly isFinal: boolean;
  readonly reconciliationVersion: number | null;
  readonly reconciliationStatus: string | null;
  readonly eligibleRecipients: number;
  readonly economicallyResolvedRecipients: number;
  readonly conflictCount: number;
  readonly blockingReasons: readonly string[];
  readonly evaluatedAt: string;
}

// Phase 6 Email shadow-rating contracts. These are internal/platform-facing;
// existing tenant campaign DTOs deliberately do not expose wholesale values.
export interface EmailShadowRatingDto {
  readonly id: string;
  readonly tenantId: string;
  readonly campaignId: string;
  readonly campaignRecipientId: string;
  readonly ratingVersion: number;
  readonly provider: string | null;
  readonly providerMessageId: string | null;
  readonly destination: string;
  readonly quantity: number;
  readonly unit: string;
  readonly rateMicroPaise: string | null;
  readonly providerCostMicroPaise: string | null;
  readonly legacyCustomerChargePaise: string | null;
  readonly status: string;
  readonly unavailableReason: string | null;
  readonly costSource: CostSource | null;
  readonly providerRateId: string | null;
  readonly policyReference: string | null;
  readonly occurredAt: string | null;
  readonly ratedAt: string;
  readonly createdAt: string;
}

export interface EmailCampaignShadowReconciliationDto {
  readonly id: string;
  readonly tenantId: string;
  readonly campaignId: string;
  readonly version: number;
  readonly isFinal: boolean;
  readonly totalRecipients: number;
  readonly eligibleRecipients: number;
  readonly ratedRecipients: number;
  readonly unratedRecipients: number;
  readonly totalProviderCostMicroPaise: string;
  readonly markupBps: number;
  readonly markupAmountMicroPaise: string;
  readonly retailAmountMicroPaise: string;
  readonly ratedLegacyTotalPaise: string;
  readonly ratedShadowTotalPaise: string;
  readonly signedDifferencePaise: string;
  readonly varianceBps: number;
  readonly status: string;
  readonly ratedAt: string;
  readonly createdAt: string;
}
