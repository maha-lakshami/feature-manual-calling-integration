import {
  Channel,
  CostSource,
  CostUnavailableReason,
  type ProviderUsage,
} from '@aiking/shared';
import {
  MetaWhatsAppCostAdapter,
  PlivoCostAdapter,
  SesEmailCostAdapter,
} from './live-cost.adapters';
import { RateCatalogService } from '../../modules/rate-catalog/rate-catalog.service';
import { RatingEngineService } from '../../modules/billing/rating-engine.service';

describe('Live Cost Adapters with RateCatalogService', () => {
  let rateCatalogMock: jest.Mocked<RateCatalogService>;
  let ratingEngine: RatingEngineService;

  beforeEach(() => {
    rateCatalogMock = {
      resolveRate: jest.fn(),
      upsertRate: jest.fn(),
      setActive: jest.fn(),
      toDto: jest.fn(),
    } as unknown as jest.Mocked<RateCatalogService>;

    ratingEngine = new RatingEngineService();
  });

  describe('PlivoCostAdapter', () => {
    it('resolves actual wholesale voice cost using configured rate catalog entry', async () => {
      const adapter = new PlivoCostAdapter(rateCatalogMock);

      rateCatalogMock.resolveRate.mockResolvedValueOnce({
        id: 'rate-plivo-1',
        provider: 'plivo',
        channel: Channel.CALL,
        destinationPattern: '+91',
        category: null,
        unit: 'second',
        rateMicroPaise: 75_000n, // 0.075 paise/sec = 4.5 paise/min
        currency: 'INR',
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
        active: true,
        version: 1,
        description: 'Standard domestic call',
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const usage: ProviderUsage = {
        tenantId: 'tenant-1',
        channel: Channel.CALL,
        quantity: 120, // 120 seconds
        unit: 'second',
        currency: 'INR',
        provider: 'plivo',
        destination: '+919876543210',
      };

      const result = await adapter.resolveActualCost(usage);

      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.cost.provider).toBe('plivo');
        expect(result.cost.channel).toBe(Channel.CALL);
        expect(result.cost.quantity).toBe(120);
        expect(result.cost.rateMicroPaise).toBe(75_000n);
        // 120 * 75,000 = 9,000,000 micro-paise = 9 paise
        expect(result.cost.costMicroPaise).toBe(9_000_000n);
        expect(result.cost.costPaise).toBe(9n);
        expect(result.cost.source).toBe(CostSource.RATE_CATALOG);

        // Feed into RatingEngine: 25% markup on 9 paise = 2.25 paise markup -> ceil = 3 paise markup -> 12 paise customer charge
        const rated = ratingEngine.rate(result.cost);
        expect(rated.customerChargePaise).toBe(12n);
      }
    });

    it('returns COST_UNAVAILABLE with RATE_NOT_CONFIGURED when no rate exists', async () => {
      const adapter = new PlivoCostAdapter(rateCatalogMock);
      rateCatalogMock.resolveRate.mockResolvedValueOnce(null);

      const usage: ProviderUsage = {
        tenantId: 'tenant-1',
        channel: Channel.CALL,
        quantity: 60,
        unit: 'second',
        currency: 'INR',
        provider: 'plivo',
      };

      const result = await adapter.resolveActualCost(usage);

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason).toBe(CostUnavailableReason.RATE_NOT_CONFIGURED);
        expect(result.provider).toBe('plivo');
      }
    });
  });

  describe('MetaWhatsAppCostAdapter', () => {
    it('passes template category from usage metadata to RateCatalogService', async () => {
      const adapter = new MetaWhatsAppCostAdapter(rateCatalogMock);

      rateCatalogMock.resolveRate.mockResolvedValueOnce({
        id: 'rate-meta-1',
        provider: 'meta',
        channel: Channel.WHATSAPP,
        destinationPattern: '+91',
        category: 'marketing',
        unit: 'message',
        rateMicroPaise: 780_000n, // 0.78 paise
        currency: 'INR',
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
        active: true,
        version: 1,
        description: 'Marketing template',
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const usage: ProviderUsage = {
        tenantId: 'tenant-1',
        channel: Channel.WHATSAPP,
        quantity: 1,
        unit: 'message',
        currency: 'INR',
        provider: 'meta',
        destination: '+919876543210',
        metadata: { category: 'marketing' },
      };

      const result = await adapter.resolveActualCost(usage);

      expect(rateCatalogMock.resolveRate).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'meta',
          channel: Channel.WHATSAPP,
          destination: '+919876543210',
          category: 'marketing',
        }),
      );

      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.cost.rateMicroPaise).toBe(780_000n);
        expect(result.cost.costMicroPaise).toBe(780_000n);
        expect(result.cost.costPaise).toBe(1n); // ceil(0.78) = 1
      }
    });
  });

  describe('SesEmailCostAdapter', () => {
    it('resolves actual wholesale email cost from RateCatalogService', async () => {
      const adapter = new SesEmailCostAdapter(rateCatalogMock);

      rateCatalogMock.resolveRate.mockResolvedValueOnce({
        id: 'rate-ses-1',
        provider: 'ses',
        channel: Channel.EMAIL,
        destinationPattern: '*',
        category: null,
        unit: 'email',
        rateMicroPaise: 840_000n, // 0.84 paise / email
        currency: 'INR',
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
        active: true,
        version: 1,
        description: 'SES transaction email',
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const usage: ProviderUsage = {
        tenantId: 'tenant-1',
        channel: Channel.EMAIL,
        quantity: 10,
        unit: 'email',
        currency: 'INR',
        provider: 'ses',
      };

      const result = await adapter.resolveActualCost(usage);

      expect(result.available).toBe(true);
      if (result.available) {
        // 10 * 840,000 = 8,400,000 micro-paise = 8.4 paise
        expect(result.cost.costMicroPaise).toBe(8_400_000n);
        // ceil(8.4) = 9 paise
        expect(result.cost.costPaise).toBe(9n);

        // Rating with 25% markup:
        // Retail micro-paise = 8,400,000 + ceil(8,400,000 * 25 / 100) = 8,400,000 + 2,100,000 = 10,500,000 micro-paise (10.5 paise)
        // Customer charge = ceil(10.5) = 11 paise
        const rated = ratingEngine.rate(result.cost);
        expect(rated.customerChargePaise).toBe(11n);
      }
    });
  });
});
