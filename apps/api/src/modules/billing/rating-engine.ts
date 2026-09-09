import {
  BPS_DENOMINATOR,
  DEFAULT_MARKUP_BPS,
  MICRO_PAISE_FACTOR,
  MoneyError,
  paiseToMicroPaise,
  type NormalizedProviderCost,
  type PricingPolicy,
  type RatedCustomerCharge,
} from '@aiking/shared';

/**
 * Pure calculation of customer retail charge from wholesale provider cost and markup basis points.
 *
 * Rules:
 * - Integer-safe BigInt arithmetic throughout. No floating-point money.
 * - Sub-paisa precision preserved end-to-end using BigInt micro-paise (1 paisa = 1,000,000 micro-paise).
 * - Single ceiling division round at final customer settlement to integer paise.
 * - Negative costs, negative markup basis points, and non-positive quantities fail closed.
 */
export function calculateCustomerChargeMicroPaise(
  providerCostMicroPaise: bigint,
  currency: string,
  markupBps: number = DEFAULT_MARKUP_BPS,
): RatedCustomerCharge {
  if (providerCostMicroPaise < 0n) {
    throw new MoneyError(`Provider cost cannot be negative, received: ${providerCostMicroPaise}`);
  }

  if (markupBps < 0) {
    throw new MoneyError(`Markup basis points cannot be negative, received: ${markupBps}`);
  }

  if (!currency || !currency.trim()) {
    throw new MoneyError('Currency code is required for rating');
  }

  let markupAmountMicroPaise = 0n;

  if (markupBps > 0) {
    const product = providerCostMicroPaise * BigInt(markupBps);
    // Ceiling division at basis point denominator
    markupAmountMicroPaise = (product + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR;
  }

  const retailAmountMicroPaise = providerCostMicroPaise + markupAmountMicroPaise;

  // Round ONCE at final customer settlement to integer paise using ceiling division:
  const customerChargePaise = (retailAmountMicroPaise + (MICRO_PAISE_FACTOR - 1n)) / MICRO_PAISE_FACTOR;

  // Derived / compatibility paise representation:
  const providerCostPaise = (providerCostMicroPaise + (MICRO_PAISE_FACTOR - 1n)) / MICRO_PAISE_FACTOR;
  const markupAmountPaise =
    customerChargePaise >= providerCostPaise ? customerChargePaise - providerCostPaise : 0n;

  return {
    providerCostPaise,
    markupBps,
    markupAmountPaise,
    customerChargePaise,
    currency,
    providerCostMicroPaise,
    markupAmountMicroPaise,
    retailAmountMicroPaise,
  };
}

/**
 * Calculate customer charge directly from wholesale paise and currency.
 * Converts to micro-paise, applies markup, and rounds once at settlement.
 */
export function calculateCustomerCharge(
  providerCostPaise: bigint,
  currency: string,
  markupBps: number = DEFAULT_MARKUP_BPS,
): RatedCustomerCharge {
  return calculateCustomerChargeMicroPaise(paiseToMicroPaise(providerCostPaise), currency, markupBps);
}

/**
 * Rate a normalized provider cost using the given pricing policy.
 * Uses exact micro-paise if provided, preserving fractional-paisa economics.
 */
export function rateCost(
  cost: NormalizedProviderCost,
  policy: PricingPolicy = { markupBps: DEFAULT_MARKUP_BPS },
): RatedCustomerCharge {
  if (cost.quantity <= 0 || !Number.isFinite(cost.quantity)) {
    throw new MoneyError(`Usage quantity must be positive, received: ${cost.quantity}`);
  }

  const providerCostMicroPaise =
    cost.costMicroPaise !== undefined ? cost.costMicroPaise : paiseToMicroPaise(cost.costPaise);

  return calculateCustomerChargeMicroPaise(providerCostMicroPaise, cost.currency, policy.markupBps);
}
