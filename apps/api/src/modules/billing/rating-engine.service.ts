import { Injectable, Logger } from '@nestjs/common';
import {
  Channel,
  DEFAULT_MARKUP_BPS,
  type NormalizedProviderCost,
  type PricingPolicy,
  type RatedCustomerCharge,
} from '@aiking/shared';
import { calculateCustomerCharge, calculateCustomerChargeMicroPaise, rateCost } from './rating-engine';

/**
 * Service managing policy resolution and usage rating.
 *
 * Precedence hierarchy (extensible for Phase 2):
 *   1. Tenant + Channel override (negotiated rate for a specific medium)
 *   2. Tenant default (negotiated baseline rate across all services)
 *   3. Channel default (platform rate for voice vs. whatsapp vs. email)
 *   4. Global platform default (DEFAULT_MARKUP_BPS = 2500 = 25%)
 *
 * All rate calculations remain pure and integer-safe.
 */
@Injectable()
export class RatingEngineService {
  private readonly logger = new Logger(RatingEngineService.name);

  /**
   * Resolve effective pricing policy based on precedence rules.
   *
   * In this foundation phase, database-backed levels are not yet added to avoid
   * premature migrations, but the interface cleanly separates policy lookup
   * from calculation.
   */
  resolvePolicy(tenantId?: string, channel?: Channel): PricingPolicy {
    // 1. Tenant + Channel override
    const tenantChannelOverride = this.lookupTenantChannelOverride(tenantId, channel);
    if (tenantChannelOverride) return tenantChannelOverride;

    // 2. Tenant default override
    const tenantDefaultOverride = this.lookupTenantDefaultOverride(tenantId);
    if (tenantDefaultOverride) return tenantDefaultOverride;

    // 3. Channel default override
    const channelDefaultOverride = this.lookupChannelDefaultOverride(channel);
    if (channelDefaultOverride) return channelDefaultOverride;

    // 4. Global fallback default (single source of truth: DEFAULT_MARKUP_BPS = 2500)
    return { markupBps: DEFAULT_MARKUP_BPS };
  }

  /**
   * Rate an authoritative wholesale provider cost to produce the customer retail charge.
   */
  rate(cost: NormalizedProviderCost, policyOverride?: PricingPolicy): RatedCustomerCharge {
    const policy = policyOverride ?? this.resolvePolicy(undefined, cost.channel);
    return rateCost(cost, policy);
  }

  /**
   * Calculate customer charge directly from wholesale paise and currency.
   */
  calculate(
    providerCostPaise: bigint,
    currency: string,
    markupBps: number = DEFAULT_MARKUP_BPS,
  ): RatedCustomerCharge {
    return calculateCustomerCharge(providerCostPaise, currency, markupBps);
  }

  /**
   * Calculate customer charge directly from wholesale micro-paise and currency.
   */
  calculateMicroPaise(
    providerCostMicroPaise: bigint,
    currency: string,
    markupBps: number = DEFAULT_MARKUP_BPS,
  ): RatedCustomerCharge {
    return calculateCustomerChargeMicroPaise(providerCostMicroPaise, currency, markupBps);
  }

  // ── Precedence Stubs for Phase 2 DB/Cache integration ─────────────────────

  private lookupTenantChannelOverride(_tenantId?: string, _channel?: Channel): PricingPolicy | null {
    return null;
  }

  private lookupTenantDefaultOverride(_tenantId?: string): PricingPolicy | null {
    return null;
  }

  private lookupChannelDefaultOverride(_channel?: Channel): PricingPolicy | null {
    return null;
  }
}
