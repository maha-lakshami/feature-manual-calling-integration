import {
  Channel,
  CostSource,
  CostUnavailableReason,
  DEFAULT_MARKUP_BPS,
  MoneyError,
  type NormalizedProviderCost,
  type ProviderCostResolution,
  type ProviderUsage,
} from '@aiking/shared';
import type { ProviderCostResolver } from '../../providers/cost/cost-resolver.interface';
import { CostRegistryService } from '../../providers/cost/cost-registry.service';
import {
  MetaWhatsAppCostAdapter,
  PlivoCostAdapter,
  SesEmailCostAdapter,
} from '../../providers/cost/live-cost.adapters';
import { calculateCustomerCharge, calculateCustomerChargeMicroPaise, rateCost } from './rating-engine';
import { RatingEngineService } from './rating-engine.service';

describe('Rating Engine & Provider Cost Foundation', () => {
  let ratingService: RatingEngineService;

  beforeEach(() => {
    ratingService = new RatingEngineService();
  });

  // ── 1. ₹100 provider cost + 2500 bps ───────────────────────────────────────

  it('1. calculates ₹125 customer charge for ₹100 provider cost with 2500 bps markup', () => {
    // ₹100 = 10,000 paise; 2500 bps = 25%
    const providerCostPaise = 10000n;
    const markupBps = 2500;

    const result = calculateCustomerCharge(providerCostPaise, 'INR', markupBps);

    expect(result.providerCostPaise).toBe(10000n);
    expect(result.markupBps).toBe(2500);
    expect(result.markupAmountPaise).toBe(2500n); // ₹25.00
    expect(result.customerChargePaise).toBe(12500n); // ₹125.00
    expect(result.currency).toBe('INR');
  });

  // ── 2. Zero markup ─────────────────────────────────────────────────────────

  it('2. returns customer charge equal to provider cost when markup is zero', () => {
    const providerCostPaise = 50000n; // ₹500
    const markupBps = 0;

    const result = calculateCustomerCharge(providerCostPaise, 'INR', markupBps);

    expect(result.providerCostPaise).toBe(50000n);
    expect(result.markupBps).toBe(0);
    expect(result.markupAmountPaise).toBe(0n);
    expect(result.customerChargePaise).toBe(50000n);
  });

  // ── 3. Different markup policy ─────────────────────────────────────────────

  it('3. applies different markup policies correctly (10% and 50%)', () => {
    const cost = 10000n; // ₹100

    // 1000 bps = 10%
    const charge10 = calculateCustomerCharge(cost, 'INR', 1000);
    expect(charge10.markupAmountPaise).toBe(1000n);
    expect(charge10.customerChargePaise).toBe(11000n); // ₹110

    // 5000 bps = 50%
    const charge50 = calculateCustomerCharge(cost, 'INR', 5000);
    expect(charge50.markupAmountPaise).toBe(5000n);
    expect(charge50.customerChargePaise).toBe(15000n); // ₹150
  });

  // ── 4. Fractional-paise calculation with deterministic ceiling rounding ────

  it('4. performs deterministic ceiling rounding on fractional paise so platform never undercharges', () => {
    const markupBps = 2500; // 25%

    // 1 paisa * 25% = 0.25 paise -> rounded up to 1 paisa
    const charge1 = calculateCustomerCharge(1n, 'INR', markupBps);
    expect(charge1.markupAmountPaise).toBe(1n);
    expect(charge1.customerChargePaise).toBe(2n);

    // 3 paise * 25% = 0.75 paise -> rounded up to 1 paisa
    const charge3 = calculateCustomerCharge(3n, 'INR', markupBps);
    expect(charge3.markupAmountPaise).toBe(1n);
    expect(charge3.customerChargePaise).toBe(4n);

    // 4 paise * 25% = 1.00 paise -> exact 1 paisa (no remainder)
    const charge4 = calculateCustomerCharge(4n, 'INR', markupBps);
    expect(charge4.markupAmountPaise).toBe(1n);
    expect(charge4.customerChargePaise).toBe(5n);

    // 5 paise * 25% = 1.25 paise -> rounded up to 2 paise
    const charge5 = calculateCustomerCharge(5n, 'INR', markupBps);
    expect(charge5.markupAmountPaise).toBe(2n);
    expect(charge5.customerChargePaise).toBe(7n);
  });

  // ── 5. Large bigint values with no precision loss ──────────────────────────

  it('5. handles large BigInt values without IEEE-754 precision loss', () => {
    // 100 trillion paise = 1 trillion rupees (exceeds Number.MAX_SAFE_INTEGER = 9e15)
    const hugeCostPaise = 100_000_000_000_000_000n;
    const markupBps = 2500;

    const result = calculateCustomerCharge(hugeCostPaise, 'INR', markupBps);

    // 25% of 100e15 = 25e15 paise
    const expectedMarkup = 25_000_000_000_000_000n;
    const expectedTotal = 125_000_000_000_000_000n;

    expect(result.markupAmountPaise).toBe(expectedMarkup);
    expect(result.customerChargePaise).toBe(expectedTotal);
  });

  // ── 6. Cost unavailable: no fabricated retail result ───────────────────────

  it('6. returns explicit cost_unavailable from live adapters without fabricating a price', async () => {
    const mockCatalog = { resolveRate: jest.fn().mockResolvedValue(null) } as any;
    const plivo = new PlivoCostAdapter(mockCatalog);
    const meta = new MetaWhatsAppCostAdapter(mockCatalog);
    const ses = new SesEmailCostAdapter(mockCatalog);
    const registry = new CostRegistryService(plivo, meta, ses);

    const callUsage: ProviderUsage = {
      tenantId: 'tenant-123',
      channel: Channel.CALL,
      quantity: 5,
      unit: 'minute',
      currency: 'INR',
      provider: 'plivo',
      providerReference: 'call_test_123',
    };

    const actual = await registry.resolveActualCost(callUsage);
    expect(actual.available).toBe(false);
    if (!actual.available) {
      expect(actual.provider).toBe('plivo');
      expect(actual.channel).toBe(Channel.CALL);
      expect(actual.reason).toBe(CostUnavailableReason.RATE_NOT_CONFIGURED);
      expect(actual.message).toContain('No active wholesale rate configured for plivo');
    }

    const estimate = await registry.estimateCost(callUsage);
    expect(estimate.available).toBe(false);
    if (!estimate.available) {
      expect(estimate.reason).toBe(CostUnavailableReason.RATE_NOT_CONFIGURED);
    }
  });

  // ── 7. Provider adapter swappability ───────────────────────────────────────

  it('7. allows swapping provider adapters without changing rating engine logic', async () => {
    // Plivo test adapter
    class MockPlivoAdapter implements ProviderCostResolver {
      readonly provider = 'plivo';
      readonly supportedChannels = [Channel.CALL] as const;
      async estimateCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
        return {
          available: true,
          cost: {
            provider: 'plivo',
            channel: usage.channel,
            quantity: usage.quantity,
            unit: 'minute',
            currency: 'INR',
            costPaise: 15000n, // ₹150 wholesale
            source: CostSource.ESTIMATE,
            calculatedAt: new Date(),
          },
        };
      }
      async resolveActualCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
        return this.estimateCost(usage);
      }
    }

    // Twilio test adapter
    class MockTwilioAdapter implements ProviderCostResolver {
      readonly provider = 'twilio';
      readonly supportedChannels = [Channel.CALL] as const;
      async estimateCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
        return {
          available: true,
          cost: {
            provider: 'twilio',
            channel: usage.channel,
            quantity: usage.quantity,
            unit: 'minute',
            currency: 'INR',
            costPaise: 15000n, // identical ₹150 wholesale
            source: CostSource.PROVIDER_API,
            calculatedAt: new Date(),
          },
        };
      }
      async resolveActualCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
        return this.estimateCost(usage);
      }
    }

    const usage: ProviderUsage = {
      tenantId: 'tenant-123',
      channel: Channel.CALL,
      quantity: 3,
      unit: 'minute',
      currency: 'INR',
      provider: 'plivo',
    };

    const plivoAdapter = new MockPlivoAdapter();
    const twilioAdapter = new MockTwilioAdapter();

    const plivoRes = await plivoAdapter.resolveActualCost(usage);
    const twilioRes = await twilioAdapter.resolveActualCost({ ...usage, provider: 'twilio' });

    expect(plivoRes.available).toBe(true);
    expect(twilioRes.available).toBe(true);

    if (plivoRes.available && twilioRes.available) {
      // Both feed into the exact same rating service
      const plivoRated = ratingService.rate(plivoRes.cost);
      const twilioRated = ratingService.rate(twilioRes.cost);

      // 25% markup on ₹150 (15000 paise) = 3750 paise markup -> 18750 paise total
      expect(plivoRated.markupAmountPaise).toBe(3750n);
      expect(plivoRated.customerChargePaise).toBe(18750n);
      expect(twilioRated.markupAmountPaise).toBe(3750n);
      expect(twilioRated.customerChargePaise).toBe(18750n);
    }
  });

  // ── 8. Plivo and Twilio style test adapters return same normalized contract ─

  it('8. ensures different provider adapters adhere to the identical NormalizedProviderCost contract', async () => {
    const costPlivo: NormalizedProviderCost = {
      provider: 'plivo',
      channel: Channel.CALL,
      quantity: 2,
      unit: 'minute',
      currency: 'INR',
      costPaise: 8000n,
      source: CostSource.RATE_CATALOG,
      calculatedAt: new Date(),
      externalReference: 'plivo-call-uuid-1',
    };

    const costTwilio: NormalizedProviderCost = {
      provider: 'twilio',
      channel: Channel.CALL,
      quantity: 2,
      unit: 'minute',
      currency: 'INR',
      costPaise: 8000n,
      source: CostSource.PROVIDER_API,
      calculatedAt: new Date(),
      externalReference: 'twilio-call-sid-1',
    };

    // Both satisfy NormalizedProviderCost contract
    const ratedPlivo = rateCost(costPlivo);
    const ratedTwilio = rateCost(costTwilio);

    expect(ratedPlivo.customerChargePaise).toBe(10000n); // 8000 + 2000 (25%)
    expect(ratedTwilio.customerChargePaise).toBe(10000n);
  });

  // ── 9. Currency is preserved ───────────────────────────────────────────────

  it('9. preserves currency throughout rating calculations', () => {
    const inrCharge = calculateCustomerCharge(1000n, 'INR', 2500);
    expect(inrCharge.currency).toBe('INR');

    const usdCharge = calculateCustomerCharge(1000n, 'USD', 2500);
    expect(usdCharge.currency).toBe('USD');

    const eurCost: NormalizedProviderCost = {
      provider: 'test',
      channel: Channel.WHATSAPP,
      quantity: 1,
      unit: 'message',
      currency: 'EUR',
      costPaise: 2000n,
      source: CostSource.PROVIDER_API,
      calculatedAt: new Date(),
    };

    const ratedEur = rateCost(eurCost);
    expect(ratedEur.currency).toBe('EUR');
  });

  // ── 10. Invalid negative cost/quantity fails closed ────────────────────────

  it('10. fails closed on negative cost, negative markup, or invalid quantity', () => {
    // Negative cost
    expect(() => calculateCustomerCharge(-100n, 'INR', 2500)).toThrow(MoneyError);

    // Negative markup
    expect(() => calculateCustomerCharge(100n, 'INR', -100)).toThrow(MoneyError);

    // Empty currency
    expect(() => calculateCustomerCharge(100n, '', 2500)).toThrow(MoneyError);

    // Invalid zero or negative quantity in rateCost
    const invalidQuantityCost: NormalizedProviderCost = {
      provider: 'plivo',
      channel: Channel.CALL,
      quantity: 0,
      unit: 'minute',
      currency: 'INR',
      costPaise: 500n,
      source: CostSource.ESTIMATE,
      calculatedAt: new Date(),
    };

    expect(() => rateCost(invalidQuantityCost)).toThrow(MoneyError);

    // Invalid tenantId in usage validation
    const mockCatalog = { resolveRate: jest.fn() } as any;
    const registry = new CostRegistryService(
      new PlivoCostAdapter(mockCatalog),
      new MetaWhatsAppCostAdapter(mockCatalog),
      new SesEmailCostAdapter(mockCatalog),
    );

    const invalidTenantUsage: ProviderUsage = {
      tenantId: '',
      channel: Channel.CALL,
      quantity: 1,
      unit: 'minute',
      currency: 'INR',
      provider: 'plivo',
    };

    expect(registry.resolveActualCost(invalidTenantUsage)).rejects.toThrow(
      /valid, trusted internal tenantId/i,
    );
  });

  // ── 11. Sub-paisa micro-paise precision and single-rounding ────────────────

  it('11. preserves sub-paisa micro-paise precision and rounds customer charge once', () => {
    // 1 email @ 840,000 micro-paise (0.84 paise) + 2500 bps (25%) markup
    const single = calculateCustomerChargeMicroPaise(840_000n, 'INR', 2500);
    expect(single.providerCostMicroPaise).toBe(840_000n);
    expect(single.markupAmountMicroPaise).toBe(210_000n);
    expect(single.retailAmountMicroPaise).toBe(1_050_000n); // 1.05 paise
    // Rounded once using ceiling division to integer paise: ceil(1.05) = 2 paise
    expect(single.customerChargePaise).toBe(2n);
    expect(single.providerCostPaise).toBe(1n); // ceil(0.84) = 1 paisa
    expect(single.markupAmountPaise).toBe(1n);

    // 1,000 emails @ 840,000 micro-paise = 840,000,000 micro-paise (840 paise = ₹8.40)
    const bulk = calculateCustomerChargeMicroPaise(840_000_000n, 'INR', 2500);
    expect(bulk.providerCostMicroPaise).toBe(840_000_000n);
    expect(bulk.markupAmountMicroPaise).toBe(210_000_000n);
    expect(bulk.retailAmountMicroPaise).toBe(1_050_000_000n); // ₹10.50
    expect(bulk.customerChargePaise).toBe(1050n); // 1,050 paise
    expect(bulk.providerCostPaise).toBe(840n);
    expect(bulk.markupAmountPaise).toBe(210n);
  });

  // ── Policy Precedence hierarchy verification ───────────────────────────────

  it('resolves default policy precedence with DEFAULT_MARKUP_BPS = 2500', () => {
    const policy = ratingService.resolvePolicy('any-tenant-id', Channel.CALL);
    expect(policy.markupBps).toBe(DEFAULT_MARKUP_BPS);
    expect(policy.markupBps).toBe(2500);
  });
});
