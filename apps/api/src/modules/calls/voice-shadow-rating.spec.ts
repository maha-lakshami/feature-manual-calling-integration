import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import { Channel, CostSource } from '@aiking/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { ExtendedPrismaClient, createTenantIsolationExtension } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { RateCatalogService } from '../rate-catalog/rate-catalog.service';
import { RatingEngineService } from '../billing/rating-engine.service';
import { CostRegistryService } from '../../providers/cost/cost-registry.service';
import { PlivoCostAdapter, MetaWhatsAppCostAdapter, SesEmailCostAdapter } from '../../providers/cost/live-cost.adapters';
import { VoiceShadowRatingService } from './voice-shadow-rating.service';

describe('VoiceShadowRatingService (Phase 4)', () => {
  let service: VoiceShadowRatingService;
  let rateCatalog: RateCatalogService;
  let ratingEngine: RatingEngineService;
  let prisma: ExtendedPrismaClient;
  let tenantContext: TenantContext;

  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';
  let contactAId: string;
  let contactBId: string;

  function createCall(data: any) {
    return tenantContext.runWithTenant(
      {
        tenantId: data.tenantId,
        userId: 'test-user',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => await prisma.call.create({ data }),
    );
  }

  function getCallShadowRating(callId: string, tenantId = tenantA) {
    return tenantContext.runWithTenant(
      {
        tenantId,
        userId: 'test-user',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () =>
        await prisma.callShadowRating.findUnique({
          where: { call_shadow_ratings_tenant_call_unique: { tenantId, callId } },
        }),
    );
  }

  function countCallShadowRatings(callId: string, tenantId = tenantA) {
    return tenantContext.runWithTenant(
      {
        tenantId,
        userId: 'test-user',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => await prisma.callShadowRating.count({ where: { callId } }),
    );
  }

  beforeAll(async () => {
    tenantContext = new TenantContext();

    const adapter = new PrismaPg({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://aiking:aiking@127.0.0.1:5433/aiking',
    });
    const baseClient = new PrismaClient({ adapter });
    prisma = baseClient.$extends(createTenantIsolationExtension(tenantContext)) as unknown as ExtendedPrismaClient;

    rateCatalog = new RateCatalogService(prisma);
    ratingEngine = new RatingEngineService();

    const plivoAdapter = new PlivoCostAdapter(rateCatalog);
    const metaAdapter = new MetaWhatsAppCostAdapter(rateCatalog);
    const sesAdapter = new SesEmailCostAdapter(rateCatalog);
    const costRegistry = new CostRegistryService(plivoAdapter, metaAdapter, sesAdapter);

    service = new VoiceShadowRatingService(
      prisma,
      costRegistry,
      ratingEngine,
      tenantContext,
    );

    // Setup tenants
    await tenantContext.runAsSystem('setup tenant A', async () =>
      await prisma.tenant.upsert({
        where: { id: tenantA },
        create: { id: tenantA, name: 'Tenant A', slug: 'tenant-a-shadow' },
        update: {},
      }),
    );
    await tenantContext.runAsSystem('setup tenant B', async () =>
      await prisma.tenant.upsert({
        where: { id: tenantB },
        create: { id: tenantB, name: 'Tenant B', slug: 'tenant-b-shadow' },
        update: {},
      }),
    );

    // Create test contacts under tenant scope (upsert to prevent parallel test collision)
    const contactA = await tenantContext.runWithTenant(
      {
        tenantId: tenantA,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () =>
        await prisma.contact.upsert({
          where: { tenantId_phone: { tenantId: tenantA, phone: '+919876543210' } },
          create: {
            tenantId: tenantA,
            fullName: 'Contact A',
            phone: '+919876543210',
          },
          update: {},
        }),
    );
    contactAId = contactA.id;

    const contactB = await tenantContext.runWithTenant(
      {
        tenantId: tenantB,
        userId: 'user-2',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () =>
        await prisma.contact.upsert({
          where: { tenantId_phone: { tenantId: tenantB, phone: '+919123456789' } },
          create: {
            tenantId: tenantB,
            fullName: 'Contact B',
            phone: '+919123456789',
          },
          update: {},
        }),
    );
    contactBId = contactB.id;
  });

  beforeEach(async () => {
    await tenantContext.runAsSystem('clean shadow rating conflicts', async () =>
      await prisma.callShadowRatingConflict.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      }),
    );
    await tenantContext.runAsSystem('clean shadow ratings', async () =>
      await prisma.callShadowRating.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      }),
    );
    await tenantContext.runAsSystem('clean calls', async () =>
      await prisma.call.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      }),
    );
    await tenantContext.runAsSystem('clean provider rates', async () =>
      await prisma.providerRate.deleteMany({
        where: { provider: { in: ['plivo', 'test-telephony', 'mock-telephony'] } },
      }),
    );
  });

  afterAll(async () => {
    await tenantContext.runAsSystem('clean shadow rating conflicts', async () =>
      await prisma.callShadowRatingConflict.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      }),
    );
    await tenantContext.runAsSystem('clean shadow ratings', async () =>
      await prisma.callShadowRating.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      }),
    );
    await tenantContext.runAsSystem('clean calls', async () =>
      await prisma.call.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      }),
    );
    await tenantContext.runAsSystem('clean contacts', async () => {
      const ids = [contactAId, contactBId].filter(Boolean) as string[];
      if (ids.length > 0) {
        await prisma.contact.deleteMany({
          where: { id: { in: ids } },
        });
      }
    });
    await tenantContext.runAsSystem('clean provider rates', async () =>
      await prisma.providerRate.deleteMany({
        where: { provider: { in: ['plivo', 'test-telephony', 'mock-telephony'] } },
      }),
    );
    await prisma.$disconnect();
  });

  it('rates a completed call with matching rate, exact integer BillDuration, and 25% ceil markup', async () => {
    // Setup rate in rate catalog: Plivo +91 at 2,000,000 micro-paise/sec (₹1.20/min)
    const rate = await rateCatalog.upsertRate({
      provider: 'plivo',
      channel: Channel.CALL,
      destinationPattern: '+91',
      unit: 'second',
      currency: 'INR',
      rateMicroPaise: 2_000_000n,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const endedAt = new Date('2026-09-01T12:00:00Z');

    // Create call with explicit provider 'plivo' and endedAt
    const call = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: 'plivo',
      providerCallId: 'plivo-call-1',
      fromNumber: '+911111111111',
      toNumber: '+919876543210',
      durationSeconds: 75,
      billedMinutes: 2,
      costPaise: 300n, // Legacy 2 mins * 150 paise = 300 paise
      endedAt,
    });

    const result = await tenantContext.runAsWorker(tenantA, 'test shadow rating', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 75,
        legacyCostPaise: 300n,
      });
    });

    expect(result.recorded).toBe(true);
    if (!result.recorded) return;

    expect(result.isDuplicate).toBe(false);
    expect(result.shadowRating.status).toBe('RATED');
    expect(result.shadowRating.provider).toBe('plivo');
    expect(result.shadowRating.billableSeconds).toBe(75);
    expect(result.shadowRating.providerRateId).toBe(rate.id);
    expect(result.shadowRating.costSource).toBe(CostSource.RATE_CATALOG);

    // 75s * 2,000,000 = 150,000,000 micro-paise
    expect(result.shadowRating.providerCostMicroPaise).toBe(150_000_000n);
    // 25% markup on 150,000,000 = 37,500,000 micro-paise
    expect(result.shadowRating.markupAmountMicroPaise).toBe(37_500_000n);
    // Retail = 187,500,000 micro-paise
    expect(result.shadowRating.retailAmountMicroPaise).toBe(187_500_000n);
    // Ceil(187,500,000 / 1,000,000) = 188 paise
    expect(result.shadowRating.shadowCustomerChargePaise).toBe(188n);
    // Legacy charge = 300 paise
    expect(result.shadowRating.legacyCustomerChargePaise).toBe(300n);
    // Variance = 188 - 300 = -112 paise
    expect(result.shadowRating.differencePaise).toBe(-112n);
    // Exact persisted endedAt used as occurredAt
    expect(result.shadowRating.occurredAt).toBe(endedAt.toISOString());
  });

  it('fails closed with PROVIDER_UNKNOWN when historical Call has no provider, without assuming Plivo', async () => {
    const endedAt = new Date('2026-09-01T12:00:00Z');

    // Create historical call without provider (null)
    const call = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: null, // Legacy historical call
      providerCallId: 'legacy-call-no-provider',
      fromNumber: '+911111111111',
      toNumber: '+919876543210',
      durationSeconds: 60,
      billedMinutes: 1,
      costPaise: 150n,
      endedAt,
    });

    const result = await tenantContext.runAsWorker(tenantA, 'test historical provider', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 60,
        legacyCostPaise: 150n,
      });
    });

    expect(result.recorded).toBe(true);
    if (!result.recorded) return;

    expect(result.shadowRating.status).toBe('PROVIDER_UNKNOWN');
    expect(result.shadowRating.provider).toBeNull();
    expect(result.shadowRating.unavailableReason).toBe('ORIGINATING_PROVIDER_UNKNOWN');
    expect(result.shadowRating.shadowCustomerChargePaise).toBeNull();
    expect(result.shadowRating.legacyCustomerChargePaise).toBe(150n);
  });

  it('handles zero-minute / released calls without fabricating billable seconds', async () => {
    const endedAt = new Date('2026-09-01T12:00:00Z');

    const call = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: 'plivo',
      providerCallId: 'released-call-1',
      fromNumber: '+911111111111',
      toNumber: '+919876543210',
      durationSeconds: 0,
      billedMinutes: 0,
      costPaise: 0n, // Released call
      endedAt,
    });

    const result = await tenantContext.runAsWorker(tenantA, 'test released call', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 0, // Zero bill duration
        legacyCostPaise: 0n,
      });
    });

    expect(result.recorded).toBe(true);
    if (!result.recorded) return;

    expect(result.shadowRating.status).toBe('USAGE_NOT_FOUND');
    expect(result.shadowRating.unavailableReason).toBe('NO_BILLABLE_DURATION_REPORTED');
    expect(result.shadowRating.provider).toBe('plivo');
    expect(result.shadowRating.billableSeconds).toBe(0);
    expect(result.shadowRating.legacyCustomerChargePaise).toBe(0n);
    expect(result.shadowRating.shadowCustomerChargePaise).toBeNull();
    expect(result.shadowRating.differencePaise).toBeNull();
  });

  it('handles missing BillDuration by recording USAGE_NOT_FOUND without fabricating usage', async () => {
    const endedAt = new Date('2026-09-01T12:00:00Z');

    const call = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: 'plivo',
      providerCallId: 'missing-billduration-call',
      fromNumber: '+911111111111',
      toNumber: '+919876543210',
      durationSeconds: 45,
      billedMinutes: 1,
      costPaise: 150n,
      endedAt,
    });

    const result = await tenantContext.runAsWorker(tenantA, 'test missing billduration', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: undefined, // Missing from provider callback
        legacyCostPaise: 150n,
      });
    });

    expect(result.recorded).toBe(true);
    if (!result.recorded) return;

    expect(result.shadowRating.status).toBe('USAGE_NOT_FOUND');
    expect(result.shadowRating.unavailableReason).toBe('NO_BILLABLE_DURATION_REPORTED');
    expect(result.shadowRating.billableSeconds).toBeNull();
    expect(result.shadowRating.legacyCustomerChargePaise).toBe(150n);
    expect(result.shadowRating.shadowCustomerChargePaise).toBeNull();
  });

  it('records COST_UNAVAILABLE when no wholesale rate exists in catalog', async () => {
    const endedAt = new Date('2026-09-01T12:00:00Z');

    const call = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: 'plivo',
      providerCallId: 'unconfigured-destination-call',
      fromNumber: '+911111111111',
      toNumber: '+447911123456', // UK number with no rate in catalog
      durationSeconds: 60,
      billedMinutes: 1,
      costPaise: 150n,
      endedAt,
    });

    const result = await tenantContext.runAsWorker(tenantA, 'test unconfigured rate', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 60,
        legacyCostPaise: 150n,
      });
    });

    expect(result.recorded).toBe(true);
    if (!result.recorded) return;

    expect(result.shadowRating.status).toBe('COST_UNAVAILABLE');
    expect(result.shadowRating.provider).toBe('plivo');
    expect(result.shadowRating.unavailableReason).toBe('RATE_NOT_CONFIGURED');
    expect(result.shadowRating.legacyCustomerChargePaise).toBe(150n);
    expect(result.shadowRating.shadowCustomerChargePaise).toBeNull();
  });

  it('replays identically on duplicate job and returns existing row (idempotency)', async () => {
    await rateCatalog.upsertRate({
      provider: 'plivo',
      channel: Channel.CALL,
      destinationPattern: '*',
      unit: 'second',
      currency: 'INR',
      rateMicroPaise: 1_000_000n,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const endedAt = new Date('2026-09-01T12:00:00Z');

    const call = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: 'plivo',
      providerCallId: 'idempotent-call-1',
      fromNumber: '+911111111111',
      toNumber: '+919876543210',
      durationSeconds: 120,
      billedMinutes: 2,
      costPaise: 300n,
      endedAt,
    });

    // First attempt
    const first = await tenantContext.runAsWorker(tenantA, 'first shadow attempt', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 120,
        legacyCostPaise: 300n,
      });
    });
    expect(first.recorded).toBe(true);
    expect(first.isDuplicate).toBe(false);

    // Second attempt with exact same inputs
    const second = await tenantContext.runAsWorker(tenantA, 'second shadow attempt', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 120,
        legacyCostPaise: 300n,
      });
    });

    expect(second.recorded).toBe(true);
    if (!first.recorded || !second.recorded) return;
    expect(second.isDuplicate).toBe(true);
    expect(second.conflict).toBe(false);
    expect(second.shadowRating.id).toBe(first.shadowRating.id);

    // Exactly one row in DB
    const count = await countCallShadowRatings(call.id);
    expect(count).toBe(1);
  });

  it('detects conflicting duplicate replay and does NOT overwrite original immutable row', async () => {
    await rateCatalog.upsertRate({
      provider: 'plivo',
      channel: Channel.CALL,
      destinationPattern: '*',
      unit: 'second',
      currency: 'INR',
      rateMicroPaise: 1_000_000n,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const endedAt = new Date('2026-09-01T12:00:00Z');

    const call = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: 'plivo',
      providerCallId: 'conflict-call-1',
      fromNumber: '+911111111111',
      toNumber: '+919876543210',
      durationSeconds: 60,
      billedMinutes: 1,
      costPaise: 150n,
      endedAt,
    });

    const first = await tenantContext.runAsWorker(tenantA, 'first shadow attempt', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 60,
        legacyCostPaise: 150n,
      });
    });
    expect(first.recorded).toBe(true);

    // Conflicting replay: different billableSeconds (180s instead of 60s)
    const second = await tenantContext.runAsWorker(tenantA, 'conflicting shadow attempt', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 180,
        legacyCostPaise: 150n,
      });
    });

    expect(second.recorded).toBe(false);
    if (second.recorded) return;
    expect(second.isDuplicate).toBe(true);
    expect(second.conflict).toBe(true);
    expect(second.reason).toBe('RECONCILIATION_CONFLICT');

    // Original row left unmutated in DB
    const persisted = await getCallShadowRating(call.id);
    expect(persisted).not.toBeNull();
    expect(persisted!.billableSeconds).toBe(60); // Still 60, not 180!
  });

  it('fails with INVALID_CALL_STATE when call.endedAt is missing, without timestamp fallback', async () => {
    const call = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: 'plivo',
      providerCallId: 'no-endedat-call',
      fromNumber: '+911111111111',
      toNumber: '+919876543210',
      durationSeconds: 60,
      billedMinutes: 1,
      costPaise: 150n,
      endedAt: null, // Missing endedAt
    });

    const result = await tenantContext.runAsWorker(tenantA, 'test missing endedAt', async () => {
      return service.rateCallSafely({
        callId: call.id,
        billDurationSeconds: 60,
        legacyCostPaise: 150n,
      });
    });

    expect(result.recorded).toBe(false);
    if (result.recorded) return;
    expect(result.reason).toBe('INVALID_CALL_STATE');

    const count = await countCallShadowRatings(call.id);
    expect(count).toBe(0);
  });

  it('enforces tenant isolation: tenant A cannot query or mutate tenant B call', async () => {
    const endedAt = new Date('2026-09-01T12:00:00Z');

    // Call belongs to tenant B
    const callB = await createCall({
      tenantId: tenantB,
      contactId: contactBId,
      provider: 'plivo',
      providerCallId: 'tenant-b-call',
      fromNumber: '+911111111111',
      toNumber: '+919123456789',
      durationSeconds: 60,
      billedMinutes: 1,
      costPaise: 150n,
      endedAt,
    });

    // Tenant A attempts to shadow rate tenant B's call
    const result = await tenantContext.runAsWorker(tenantA, 'cross tenant attack', async () => {
      return service.rateCallSafely({
        callId: callB.id,
        billDurationSeconds: 60,
        legacyCostPaise: 150n,
      });
    });

    expect(result.recorded).toBe(false);
    if (result.recorded) return;
    expect(result.reason).toBe('CALL_NOT_FOUND');
  });

  it('uses historical effectiveFrom rate matching call.endedAt', async () => {
    // Older rate: 1,000,000 micro-paise/s (Jan - June)
    await rateCatalog.upsertRate({
      provider: 'plivo',
      channel: Channel.CALL,
      destinationPattern: '*',
      unit: 'second',
      currency: 'INR',
      rateMicroPaise: 1_000_000n,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: new Date('2026-07-01T00:00:00Z'),
    });

    // Newer rate: 3,000,000 micro-paise/s (July onwards)
    await rateCatalog.upsertRate({
      provider: 'plivo',
      channel: Channel.CALL,
      destinationPattern: '*',
      unit: 'second',
      currency: 'INR',
      rateMicroPaise: 3_000_000n,
      effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    });

    // Historical call ended in March 2026 (should pick 1,000,000 rate)
    const historicalCall = await createCall({
      tenantId: tenantA,
      contactId: contactAId,
      provider: 'plivo',
      providerCallId: 'historical-call-march',
      fromNumber: '+911111111111',
      toNumber: '+919876543210',
      durationSeconds: 100,
      billedMinutes: 2,
      costPaise: 300n,
      endedAt: new Date('2026-03-15T10:00:00Z'),
    });

    const result = await tenantContext.runAsWorker(tenantA, 'test historical rate', async () => {
      return service.rateCallSafely({
        callId: historicalCall.id,
        billDurationSeconds: 100,
        legacyCostPaise: 300n,
      });
    });

    expect(result.recorded).toBe(true);
    if (!result.recorded) return;

    // 100s * 1,000,000 = 100,000,000 micro-paise
    expect(result.shadowRating.providerCostMicroPaise).toBe(100_000_000n);
    expect(result.shadowRating.rateMicroPaise).toBe(1_000_000n);
  });
});
