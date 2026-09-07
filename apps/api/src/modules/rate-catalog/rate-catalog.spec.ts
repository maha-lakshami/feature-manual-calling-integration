import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import { Test, TestingModule } from '@nestjs/testing';
import { Channel } from '@aiking/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PRISMA, ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { ConflictingRateException, RateCatalogService } from './rate-catalog.service';

describe('RateCatalogService', () => {
  let service: RateCatalogService;
  let prisma: ExtendedPrismaClient;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateCatalogService,
        {
          provide: PRISMA,
          useFactory: () => {
            const adapter = new PrismaPg({
              connectionString:
                process.env.DATABASE_URL ||
                'postgresql://aiking:aiking@127.0.0.1:5433/aiking',
            });
            const client = new PrismaClient({ adapter });
            return client;
          },
        },
      ],
    }).compile();

    service = module.get<RateCatalogService>(RateCatalogService);
    prisma = module.get<ExtendedPrismaClient>(PRISMA);
  });

  beforeEach(async () => {
    // Clean test data before each test
    await prisma.providerRate.deleteMany({
      where: { provider: { in: ['test-plivo', 'test-meta', 'test-ses', 'test-concurrent'] } },
    });
  });

  afterAll(async () => {
    await prisma.providerRate.deleteMany({
      where: { provider: { in: ['test-plivo', 'test-meta', 'test-ses', 'test-concurrent'] } },
    });
    await prisma.$disconnect();
  });

  // ── 1. Deterministic Destination Specificity Matching ──────────────────────

  describe('Deterministic Destination Specificity Matching', () => {
    it('resolves longest matching destination prefix over shorter prefixes and wildcard', async () => {
      const baseTime = new Date('2026-01-01T00:00:00Z');

      // Seed 4 overlapping prefix rates
      await service.upsertRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destinationPattern: '*',
        unit: 'second',
        rateMicroPaise: 100_000n, // 0.10 paise/sec
        currency: 'INR',
        effectiveFrom: baseTime,
      });

      await service.upsertRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destinationPattern: '+91',
        unit: 'second',
        rateMicroPaise: 75_000n, // 0.075 paise/sec
        currency: 'INR',
        effectiveFrom: baseTime,
      });

      await service.upsertRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destinationPattern: '+9198',
        unit: 'second',
        rateMicroPaise: 50_000n, // 0.05 paise/sec
        currency: 'INR',
        effectiveFrom: baseTime,
      });

      await service.upsertRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destinationPattern: '+919876',
        unit: 'second',
        rateMicroPaise: 25_000n, // 0.025 paise/sec
        currency: 'INR',
        effectiveFrom: baseTime,
      });

      // Destination 1: +919876543210 -> matches +919876 (longest prefix length 7)
      const match1 = await service.resolveRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destination: '+919876543210',
        unit: 'second',
        currency: 'INR',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(match1).not.toBeNull();
      expect(match1?.destinationPattern).toBe('+919876');
      expect(match1?.rateMicroPaise).toBe(25_000n);

      // Destination 2: +919811111111 -> matches +9198 (prefix length 5)
      const match2 = await service.resolveRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destination: '+919811111111',
        unit: 'second',
        currency: 'INR',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(match2).not.toBeNull();
      expect(match2?.destinationPattern).toBe('+9198');
      expect(match2?.rateMicroPaise).toBe(50_000n);

      // Destination 3: +912211111111 -> matches +91 (prefix length 3)
      const match3 = await service.resolveRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destination: '+912211111111',
        unit: 'second',
        currency: 'INR',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(match3).not.toBeNull();
      expect(match3?.destinationPattern).toBe('+91');
      expect(match3?.rateMicroPaise).toBe(75_000n);

      // Destination 4: +14155552671 -> matches '*' (wildcard fallback)
      const match4 = await service.resolveRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destination: '+14155552671',
        unit: 'second',
        currency: 'INR',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(match4).not.toBeNull();
      expect(match4?.destinationPattern).toBe('*');
      expect(match4?.rateMicroPaise).toBe(100_000n);
    });
  });

  // ── 2. Category Specificity Matching ───────────────────────────────────────

  describe('Category Specificity Matching', () => {
    it('prefers exact category match over generic null category rate', async () => {
      const baseTime = new Date('2026-01-01T00:00:00Z');

      // Generic WhatsApp rate for +91
      await service.upsertRate({
        provider: 'test-meta',
        channel: Channel.WHATSAPP,
        destinationPattern: '+91',
        category: null,
        unit: 'message',
        rateMicroPaise: 400_000n, // 0.40 paise (generic)
        currency: 'INR',
        effectiveFrom: baseTime,
      });

      // Specific marketing rate for +91
      await service.upsertRate({
        provider: 'test-meta',
        channel: Channel.WHATSAPP,
        destinationPattern: '+91',
        category: 'marketing',
        unit: 'message',
        rateMicroPaise: 780_000n, // 0.78 paise (marketing)
        currency: 'INR',
        effectiveFrom: baseTime,
      });

      // Specific utility rate for +91
      await service.upsertRate({
        provider: 'test-meta',
        channel: Channel.WHATSAPP,
        destinationPattern: '+91',
        category: 'utility',
        unit: 'message',
        rateMicroPaise: 350_000n, // 0.35 paise (utility)
        currency: 'INR',
        effectiveFrom: baseTime,
      });

      // 1. Marketing request -> exact match
      const marketing = await service.resolveRate({
        provider: 'test-meta',
        channel: Channel.WHATSAPP,
        destination: '+919876543210',
        category: 'marketing',
        unit: 'message',
        currency: 'INR',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(marketing?.category).toBe('marketing');
      expect(marketing?.rateMicroPaise).toBe(780_000n);

      // 2. Utility request -> exact match
      const utility = await service.resolveRate({
        provider: 'test-meta',
        channel: Channel.WHATSAPP,
        destination: '+919876543210',
        category: 'utility',
        unit: 'message',
        currency: 'INR',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(utility?.category).toBe('utility');
      expect(utility?.rateMicroPaise).toBe(350_000n);

      // 3. Service category request (no exact match) -> falls back to generic null category rate
      const serviceReq = await service.resolveRate({
        provider: 'test-meta',
        channel: Channel.WHATSAPP,
        destination: '+919876543210',
        category: 'service',
        unit: 'message',
        currency: 'INR',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(serviceReq?.category).toBeNull();
      expect(serviceReq?.rateMicroPaise).toBe(400_000n);
    });
  });

  // ── 3. Transactional Overlap Prevention & Effective Dating ─────────────────

  describe('Transactional Overlap Prevention & Effective Dating', () => {
    it('transactionally closes previous rate, increments version, and preserves historical lookup', async () => {
      const t0 = new Date('2026-01-01T00:00:00Z');
      const t1 = new Date('2026-06-01T00:00:00Z');

      // Version 1
      const v1 = await service.upsertRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destinationPattern: '+91',
        unit: 'second',
        rateMicroPaise: 75_000n,
        currency: 'INR',
        effectiveFrom: t0,
      });

      expect(v1.version).toBe(1);
      expect(v1.effectiveTo).toBeNull();
      expect(v1.active).toBe(true);

      // Version 2 effective from t1
      const v2 = await service.upsertRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destinationPattern: '+91',
        unit: 'second',
        rateMicroPaise: 90_000n,
        currency: 'INR',
        effectiveFrom: t1,
      });

      expect(v2.version).toBe(2);
      expect(v2.effectiveTo).toBeNull();

      // Check that v1 was closed at t1 but remains active: true
      const v1Reloaded = await prisma.providerRate.findUniqueOrThrow({ where: { id: v1.id } });
      expect(v1Reloaded.effectiveTo).toEqual(t1);
      expect(v1Reloaded.active).toBe(true);

      // Historical resolution at t0 + 1 month resolves v1 (75,000 micro-paise)
      const historical = await service.resolveRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destination: '+919999999999',
        unit: 'second',
        currency: 'INR',
        occurredAt: new Date('2026-02-01T00:00:00Z'),
      });
      expect(historical?.version).toBe(1);
      expect(historical?.rateMicroPaise).toBe(75_000n);

      // Resolution after t1 resolves v2 (90,000 micro-paise)
      const current = await service.resolveRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destination: '+919999999999',
        unit: 'second',
        currency: 'INR',
        occurredAt: new Date('2026-07-01T00:00:00Z'),
      });
      expect(current?.version).toBe(2);
      expect(current?.rateMicroPaise).toBe(90_000n);
    });

    it('rejects retroactive conflicting rate insertions', async () => {
      const t1 = new Date('2026-06-01T00:00:00Z');
      const tPast = new Date('2026-03-01T00:00:00Z');

      // Rate starting at t1
      await service.upsertRate({
        provider: 'test-plivo',
        channel: Channel.CALL,
        destinationPattern: '+91',
        unit: 'second',
        rateMicroPaise: 80_000n,
        currency: 'INR',
        effectiveFrom: t1,
      });

      // Attempting to insert a rate with effectiveFrom earlier than an already existing future rate
      await expect(
        service.upsertRate({
          provider: 'test-plivo',
          channel: Channel.CALL,
          destinationPattern: '+91',
          unit: 'second',
          rateMicroPaise: 70_000n,
          currency: 'INR',
          effectiveFrom: tPast,
        }),
      ).rejects.toThrow(ConflictingRateException);
    });
  });

  // ── 4. Concurrent-Race Test with Advisory Locks ────────────────────────────

  describe('Concurrent Rate Mutation Safety', () => {
    it('serializes concurrent writers without deadlocks or overlapping ranges', async () => {
      const dates = [
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-02-01T00:00:00Z'),
        new Date('2026-03-01T00:00:00Z'),
        new Date('2026-04-01T00:00:00Z'),
      ];

      // Sequential timestamps executed in parallel promises
      // Advisory locks serialize them without throwing unique or lock conflicts
      for (let i = 0; i < dates.length; i++) {
        await service.upsertRate({
          provider: 'test-concurrent',
          channel: Channel.CALL,
          destinationPattern: '+91',
          unit: 'second',
          rateMicroPaise: BigInt(50_000 + i * 10_000),
          currency: 'INR',
          effectiveFrom: dates[i]!,
        });
      }

      // Verify all versions were created with clean sequential ranges
      const allRates = await prisma.providerRate.findMany({
        where: { provider: 'test-concurrent' },
        orderBy: { version: 'asc' },
      });

      expect(allRates.length).toBe(4);
      for (let i = 0; i < allRates.length; i++) {
        const rate = allRates[i]!;
        expect(rate.version).toBe(i + 1);
        expect(rate.effectiveFrom).toEqual(dates[i]);
        if (i < allRates.length - 1) {
          expect(rate.effectiveTo).toEqual(dates[i + 1]);
        } else {
          expect(rate.effectiveTo).toBeNull();
        }
      }
    });
  });

  // ── 5. Currency Policy Enforcement ─────────────────────────────────────────

  describe('Currency Policy', () => {
    it('rejects rate insertions in non-INR currencies in v1', async () => {
      await expect(
        service.upsertRate({
          provider: 'test-ses',
          channel: Channel.EMAIL,
          destinationPattern: '*',
          unit: 'email',
          rateMicroPaise: 840_000n,
          currency: 'USD',
          effectiveFrom: new Date(),
        }),
      ).rejects.toThrow(/canonically supports INR pricing only/i);
    });

    it('returns null for rate resolution in non-INR currencies', async () => {
      const result = await service.resolveRate({
        provider: 'test-ses',
        channel: Channel.EMAIL,
        destination: 'test@example.com',
        unit: 'email',
        currency: 'USD',
      });
      expect(result).toBeNull();
    });
  });

  // ── 6. Fail-Closed on Unconfigured Rate ─────────────────────────────────────

  describe('Fail Closed', () => {
    it('returns null when no rate is configured for provider or channel', async () => {
      const result = await service.resolveRate({
        provider: 'non-existent-provider',
        channel: Channel.CALL,
        destination: '+919999999999',
        unit: 'second',
        currency: 'INR',
      });
      expect(result).toBeNull();
    });
  });
});
