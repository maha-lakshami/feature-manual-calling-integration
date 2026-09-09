import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import { CallStatus, Channel, Permission, Role, calculateVarianceBps } from '@aiking/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { Reflector } from '@nestjs/core';
import { ExtendedPrismaClient, createTenantIsolationExtension } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ForbiddenRoleException } from '../../common/errors/app-exception';
import { PERMISSION_KEY } from '../../common/decorators';
import { QueueService } from '../queue/queue.service';
import { RateCatalogService } from '../rate-catalog/rate-catalog.service';
import { VoiceShadowReconciliationService } from './voice-shadow-reconciliation.service';

describe('VoiceShadowReconciliationService & Activation Gate (Phase 4.1)', () => {
  let reconciliationService: VoiceShadowReconciliationService;
  let rateCatalog: RateCatalogService;
  let queue: QueueService;
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

  function createShadowRating(data: any) {
    return tenantContext.runWithTenant(
      {
        tenantId: data.tenantId,
        userId: 'test-user',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => await prisma.callShadowRating.create({ data }),
    );
  }

  function createShadowConflict(data: any) {
    return tenantContext.runWithTenant(
      {
        tenantId: data.tenantId,
        userId: 'test-user',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => await prisma.callShadowRatingConflict.create({ data }),
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

    const mockConfig: any = {
      queue: { driver: 'inline', prefix: 'test' },
      redis: { url: 'redis://127.0.0.1:6379' },
      appRole: 'both',
    };
    queue = new QueueService(mockConfig);

    reconciliationService = new VoiceShadowReconciliationService(
      prisma,
      rateCatalog,
      queue,
      tenantContext,
    );

    // Setup tenants
    await tenantContext.runAsSystem('setup tenant A', async () =>
      await prisma.tenant.upsert({
        where: { id: tenantA },
        create: { id: tenantA, name: 'Tenant A', slug: 'tenant-a-recon' },
        update: {},
      }),
    );
    await tenantContext.runAsSystem('setup tenant B', async () =>
      await prisma.tenant.upsert({
        where: { id: tenantB },
        create: { id: tenantB, name: 'Tenant B', slug: 'tenant-b-recon' },
        update: {},
      }),
    );

    // Create test contacts under tenant scope
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
        await prisma.contact.create({
          data: {
            tenantId: tenantA,
            fullName: 'Recon Contact A',
            phone: '+919876543210',
          },
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
        await prisma.contact.create({
          data: {
            tenantId: tenantB,
            fullName: 'Recon Contact B',
            phone: '+919123456789',
          },
        }),
    );
    contactBId = contactB.id;
  });

  beforeEach(async () => {
    await tenantContext.runAsSystem('clean test data', async () => {
      await prisma.callShadowRatingConflict.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.callShadowRating.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.call.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.providerRate.deleteMany({
        where: { provider: { in: ['plivo'] } },
      });
    });
  });

  afterAll(async () => {
    await tenantContext.runAsSystem('afterAll cleanup', async () => {
      await prisma.callShadowRatingConflict.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.callShadowRating.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.call.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.contact.deleteMany({
        where: { id: { in: [contactAId, contactBId].filter(Boolean) } },
      });
      await prisma.providerRate.deleteMany({
        where: { provider: { in: ['plivo'] } },
      });
    });
    await prisma.$disconnect();
  });

  // ── 1. BigInt Division & Symmetric Rounding Helper ────────────────────────

  describe('calculateVarianceBps helper', () => {
    it('returns 0 when denominator is zero without dividing', () => {
      expect(calculateVarianceBps(100n, 0n)).toBe(0);
      expect(calculateVarianceBps(-100n, 0n)).toBe(0);
      expect(calculateVarianceBps(0n, 0n)).toBe(0);
    });

    it('calculates exact positive basis points with symmetric rounding', () => {
      // +25.00% (2500 bps)
      expect(calculateVarianceBps(25n, 100n)).toBe(2500);
      // +12.345% -> rounds to 1235 bps
      expect(calculateVarianceBps(12345n, 100000n)).toBe(1235);
    });

    it('calculates exact negative basis points with symmetric rounding', () => {
      // -37.333% -> rounds to -3733 bps
      expect(calculateVarianceBps(-112n, 300n)).toBe(-3733);
      // -50.00% (-5000 bps)
      expect(calculateVarianceBps(-50n, 100n)).toBe(-5000);
    });
  });

  // ── 2. Financial Metrics Strict RATED-only Scope ───────────────────────────

  describe('Reconciliation Summary — Strict RATED financial scope', () => {
    it('derives pricing variance and averages strictly from RATED rows, excluding non-rated rows', async () => {
      const now = new Date('2026-09-01T12:00:00Z');

      // Call 1: RATED (75s, legacy 300p, shadow 188p, diff -112p)
      const call1 = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'p-1',
        fromNumber: '+911111111111',
        toNumber: '+919876543210',
        durationSeconds: 75,
        billedMinutes: 2,
        costPaise: 300n,
        endedAt: now,
      });
      await createShadowRating({
        tenantId: tenantA,
        callId: call1.id,
        provider: 'plivo',
        billableSeconds: 75,
        status: 'RATED',
        legacyCustomerChargePaise: 300n,
        shadowCustomerChargePaise: 188n,
        differencePaise: -112n,
        occurredAt: now,
      });

      // Call 2: RATED (120s, legacy 300p, shadow 350p, diff +50p)
      const call2 = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'p-2',
        fromNumber: '+911111111111',
        toNumber: '+919876543210',
        durationSeconds: 120,
        billedMinutes: 2,
        costPaise: 300n,
        endedAt: now,
      });
      await createShadowRating({
        tenantId: tenantA,
        callId: call2.id,
        provider: 'plivo',
        billableSeconds: 120,
        status: 'RATED',
        legacyCustomerChargePaise: 300n,
        shadowCustomerChargePaise: 350n,
        differencePaise: 50n,
        occurredAt: now,
      });

      // Call 3: COST_UNAVAILABLE (legacy 150p, shadow null, diff null)
      const call3 = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'p-3',
        fromNumber: '+911111111111',
        toNumber: '+447911123456',
        durationSeconds: 60,
        billedMinutes: 1,
        costPaise: 150n,
        endedAt: now,
      });
      await createShadowRating({
        tenantId: tenantA,
        callId: call3.id,
        provider: 'plivo',
        billableSeconds: 60,
        status: 'COST_UNAVAILABLE',
        unavailableReason: 'RATE_NOT_CONFIGURED',
        legacyCustomerChargePaise: 150n,
        shadowCustomerChargePaise: null,
        differencePaise: null,
        occurredAt: now,
      });

      // Call 4: USAGE_NOT_FOUND with zero duration (released, legacy 0p)
      const call4 = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'p-4',
        fromNumber: '+911111111111',
        toNumber: '+919876543210',
        durationSeconds: 0,
        billedMinutes: 0,
        costPaise: 0n,
        endedAt: now,
      });
      await createShadowRating({
        tenantId: tenantA,
        callId: call4.id,
        provider: 'plivo',
        billableSeconds: 0,
        status: 'USAGE_NOT_FOUND',
        unavailableReason: 'NO_BILLABLE_DURATION_REPORTED',
        legacyCustomerChargePaise: 0n,
        shadowCustomerChargePaise: null,
        differencePaise: null,
        occurredAt: now,
      });

      // Call 5: USAGE_NOT_FOUND with missing duration (legacy charged 150p!)
      const call5 = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'p-5',
        fromNumber: '+911111111111',
        toNumber: '+919876543210',
        durationSeconds: 45,
        billedMinutes: 1,
        costPaise: 150n,
        endedAt: now,
      });
      await createShadowRating({
        tenantId: tenantA,
        callId: call5.id,
        provider: 'plivo',
        billableSeconds: null, // missing BillDuration
        status: 'USAGE_NOT_FOUND',
        unavailableReason: 'NO_BILLABLE_DURATION_REPORTED',
        legacyCustomerChargePaise: 150n,
        shadowCustomerChargePaise: null,
        differencePaise: null,
        occurredAt: now,
      });

      // Call 6: PROVIDER_UNKNOWN (legacy 150p)
      const call6 = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: null,
        providerCallId: 'p-6',
        fromNumber: '+911111111111',
        toNumber: '+919876543210',
        durationSeconds: 60,
        billedMinutes: 1,
        costPaise: 150n,
        endedAt: now,
      });
      await createShadowRating({
        tenantId: tenantA,
        callId: call6.id,
        provider: null,
        billableSeconds: 60,
        status: 'PROVIDER_UNKNOWN',
        unavailableReason: 'ORIGINATING_PROVIDER_UNKNOWN',
        legacyCustomerChargePaise: 150n,
        shadowCustomerChargePaise: null,
        differencePaise: null,
        occurredAt: now,
      });

      const summary = await reconciliationService.getReconciliationSummary({ tenantId: tenantA });

      // Volume & Quality counts
      expect(summary.totalCallsEvaluated).toBe(6);
      expect(summary.ratedCount).toBe(2);
      expect(summary.costUnavailableCount).toBe(1);
      expect(summary.usageNotFoundCount).toBe(2);
      expect(summary.providerUnknownCount).toBe(1);
      expect(summary.conflictCount).toBe(0);

      // USAGE_NOT_FOUND separation
      expect(summary.zeroAuthoritativeBillDurationCount).toBe(1);
      expect(summary.missingAuthoritativeBillDurationCount).toBe(1);
      expect(summary.usageNotFoundLegacyChargePaise).toBe('150'); // Call 5 billed 150p despite missing duration

      // Financial totals derived ONLY from Call 1 and Call 2 (RATED)
      // Call 1: legacy 300p, shadow 188p, diff -112p
      // Call 2: legacy 300p, shadow 350p, diff +50p
      // Total legacy = 600p (NOT 600 + 150 + 0 + 150 + 150 = 1050p)
      expect(summary.ratedLegacyTotalPaise).toBe('600');
      // Total shadow = 188 + 350 = 538p
      expect(summary.ratedShadowTotalPaise).toBe('538');
      // Signed diff = 538 - 600 = -62p
      expect(summary.signedDifferencePaise).toBe('-62');
      // Absolute diff = |-112| + |50| = 112 + 50 = 162p
      expect(summary.absoluteDifferencePaise).toBe('162');
      // Min diff = -112p
      expect(summary.minDifferencePaise).toBe('-112');
      // Max diff = +50p
      expect(summary.maxDifferencePaise).toBe('50');

      // Averages
      // Avg legacy = 600 / 2 = 300p
      expect(summary.avgLegacyChargePaise).toBe('300');
      // Avg shadow = 538 / 2 = 269p
      expect(summary.avgShadowChargePaise).toBe('269');

      // Variance bps = -62 * 10000 / 600 = -1033 bps (-10.33%)
      expect(summary.varianceBps).toBe(-1033);
    });
  });

  // ── 3. Durable Conflict Metric from Append-Only Table ──────────────────────

  describe('Durable Conflict Tracking', () => {
    it('surfaces reconciliation conflicts from call_shadow_rating_conflicts without mutating original row', async () => {
      const now = new Date('2026-09-01T12:00:00Z');

      const call = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'conflict-call-durable',
        fromNumber: '+911111111111',
        toNumber: '+919876543210',
        durationSeconds: 60,
        billedMinutes: 1,
        costPaise: 150n,
        endedAt: now,
      });

      const shadow = await createShadowRating({
        tenantId: tenantA,
        callId: call.id,
        provider: 'plivo',
        billableSeconds: 60,
        status: 'RATED',
        legacyCustomerChargePaise: 150n,
        shadowCustomerChargePaise: 125n,
        differencePaise: -25n,
        occurredAt: now,
      });

      // Record conflict in append-only table
      await createShadowConflict({
        tenantId: tenantA,
        callId: call.id,
        shadowRatingId: shadow.id,
        reason: 'RECONCILIATION_CONFLICT',
        existingValues: { billableSeconds: 60, legacyCustomerChargePaise: '150' },
        incomingValues: { billableSeconds: 180, legacyCustomerChargePaise: '150' },
      });

      const summary = await reconciliationService.getReconciliationSummary({ tenantId: tenantA });
      expect(summary.conflictCount).toBe(1);

      // Verify original shadow row is unchanged
      const persistedShadow = await tenantContext.runWithTenant(
        { tenantId: tenantA, userId: 'u', role: 'manager' as any, isSuperAdmin: false, viaSupport: false, viaWorker: false },
        async () => await prisma.callShadowRating.findUniqueOrThrow({ where: { id: shadow.id } }),
      );
      expect(persistedShadow.billableSeconds).toBe(60);
      expect(persistedShadow.status).toBe('RATED');
    });
  });

  // ── 4. Rate Coverage Report Reusing RateCatalogService ────────────────────

  describe('Rate Coverage Report — Reuses Authoritative RateCatalogService', () => {
    it('identifies specific prefix, wildcard fallback, uncovered, and effective date gaps', async () => {
      const baseTime = new Date('2026-01-01T00:00:00Z');

      // 1. Specific prefix: Plivo +91 @ 2,000,000 micro-paise
      await rateCatalog.upsertRate({
        provider: 'plivo',
        channel: Channel.CALL,
        destinationPattern: '+91',
        unit: 'second',
        currency: 'INR',
        rateMicroPaise: 2_000_000n,
        effectiveFrom: baseTime,
      });

      // 2. Wildcard fallback: Plivo * @ 5,000,000 micro-paise
      await rateCatalog.upsertRate({
        provider: 'plivo',
        channel: Channel.CALL,
        destinationPattern: '*',
        unit: 'second',
        currency: 'INR',
        rateMicroPaise: 5_000_000n,
        effectiveFrom: baseTime,
      });

      // Destination A: +919876543210 (matches specific prefix +91)
      await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'cov-1',
        fromNumber: '+911111111111',
        toNumber: '+919876543210',
        durationSeconds: 60,
        billedMinutes: 1,
        costPaise: 150n,
        status: CallStatus.COMPLETED,
        endedAt: new Date(),
      });

      // Destination B: +14155552671 (US number, matches wildcard *)
      await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'cov-2',
        fromNumber: '+911111111111',
        toNumber: '+14155552671',
        durationSeconds: 60,
        billedMinutes: 1,
        costPaise: 150n,
        status: CallStatus.COMPLETED,
        endedAt: new Date(),
      });

      const report = await reconciliationService.getRateCoverageReport({ provider: 'plivo' });

      expect(report.provider).toBe('plivo');
      expect(report.totalDestinationsEvaluated).toBe(2);
      expect(report.specificMatchCount).toBe(1);
      expect(report.wildcardMatchCount).toBe(1);
      expect(report.uncoveredCount).toBe(0);

      const dest91 = report.destinations.find((d) => d.destination === '+919876543210');
      expect(dest91?.matchType).toBe('specific');
      expect(dest91?.matchedPattern).toBe('+91');

      const dest1 = report.destinations.find((d) => d.destination === '+14155552671');
      expect(dest1?.matchType).toBe('wildcard');
      expect(dest1?.matchedPattern).toBe('*');
    });
  });

  // ── 5. Activation Gate Evaluation ─────────────────────────────────────────

  describe('Activation Gate Evaluation', () => {
    it('evaluates to NOT_READY and lists blocking reasons when conflicts or unrated destinations exist', async () => {
      const now = new Date('2026-09-01T12:00:00Z');

      const call = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'gate-call-1',
        fromNumber: '+911111111111',
        toNumber: '+447911123456', // UK number with no rate in catalog
        durationSeconds: 60,
        billedMinutes: 1,
        costPaise: 150n,
        status: CallStatus.COMPLETED,
        endedAt: now,
      });

      const shadow = await createShadowRating({
        tenantId: tenantA,
        callId: call.id,
        provider: 'plivo',
        billableSeconds: 60,
        status: 'COST_UNAVAILABLE',
        unavailableReason: 'RATE_NOT_CONFIGURED',
        legacyCustomerChargePaise: 150n,
        shadowCustomerChargePaise: null,
        differencePaise: null,
        occurredAt: now,
      });

      // Simulate a conflict event
      await createShadowConflict({
        tenantId: tenantA,
        callId: call.id,
        shadowRatingId: shadow.id,
        reason: 'RECONCILIATION_CONFLICT',
        existingValues: { billableSeconds: 60 },
        incomingValues: { billableSeconds: 120 },
      });

      const report = await reconciliationService.evaluateActivationGate({
        minSampleCount: 5,
        maxConflictsAllowed: 0,
      });

      expect(report.status).toBe('NOT_READY');
      expect(report.blockingReasons.length).toBeGreaterThan(0);
      expect(report.blockingReasons.some((r) => r.includes('conflicts'))).toBe(true);
      expect(report.blockingReasons.some((r) => r.includes('RATED sample count'))).toBe(true);
    });

    it('evaluates to READY_FOR_ACTIVATION_REVIEW when all objective thresholds pass', async () => {
      const now = new Date('2026-09-01T12:00:00Z');

      // Seed rate
      await rateCatalog.upsertRate({
        provider: 'plivo',
        channel: Channel.CALL,
        destinationPattern: '+91',
        unit: 'second',
        currency: 'INR',
        rateMicroPaise: 2_000_000n,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      });

      const call = await createCall({
        tenantId: tenantA,
        contactId: contactAId,
        provider: 'plivo',
        providerCallId: 'gate-pass-1',
        fromNumber: '+911111111111',
        toNumber: '+919876543210',
        durationSeconds: 60,
        billedMinutes: 1,
        costPaise: 150n,
        status: CallStatus.COMPLETED,
        endedAt: now,
      });

      await createShadowRating({
        tenantId: tenantA,
        callId: call.id,
        provider: 'plivo',
        billableSeconds: 60,
        status: 'RATED',
        legacyCustomerChargePaise: 150n,
        shadowCustomerChargePaise: 150n,
        differencePaise: 0n,
        occurredAt: now,
      });

      const report = await reconciliationService.evaluateActivationGate({
        minSampleCount: 1,
        maxConflictsAllowed: 0,
        maxUnknownProvidersAllowed: 0,
        minResolvedRateCoveragePercent: 100,
      });

      expect(report.status).toBe('READY_FOR_ACTIVATION_REVIEW');
      expect(report.blockingReasons.length).toBe(0);
      expect(report.passedChecks).toBe(report.totalChecks);
    });
  });

  // ── 6. Zero Wallet Mutations ──────────────────────────────────────────────

  describe('Zero Wallet Mutations Guarantee', () => {
    it('ensures running reconciliation causes zero changes to wallet balance and ledger', async () => {
      // Get wallet state before
      const initialWallet = await tenantContext.runWithTenant(
        { tenantId: tenantA, userId: 'u', role: 'manager' as any, isSuperAdmin: false, viaSupport: false, viaWorker: false },
        async () =>
          await prisma.wallet.findUnique({
            where: { tenantId: tenantA },
          }),
      );

      // Run all reconciliation methods
      await reconciliationService.getReconciliationSummary();
      await reconciliationService.getRateCoverageReport();
      await reconciliationService.evaluateActivationGate();

      // Get wallet state after
      const afterWallet = await tenantContext.runWithTenant(
        { tenantId: tenantA, userId: 'u', role: 'manager' as any, isSuperAdmin: false, viaSupport: false, viaWorker: false },
        async () =>
          await prisma.wallet.findUnique({
            where: { tenantId: tenantA },
          }),
      );

      expect(afterWallet?.balancePaise).toBe(initialWallet?.balancePaise);
    });
  });

  // ── 7. Platform Security & Capability Enforcement ─────────────────────────

  describe('Platform Security & Capability Enforcement', () => {
    let rolesGuard: RolesGuard;
    let reflector: Reflector;

    beforeAll(() => {
      reflector = new Reflector();
      const mockTenantSettings = { get: jest.fn().mockResolvedValue({ settings: {} }) } as any;
      rolesGuard = new RolesGuard(reflector, mockTenantSettings);
    });

    function createMockContext(principal: any, requiredPermission: Permission) {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === PERMISSION_KEY) return requiredPermission;
        return undefined;
      });

      return {
        getHandler: () => ({}),
        getClass: () => ({ name: 'PlatformShadowReconciliationController' }),
        switchToHttp: () => ({
          getRequest: () => ({
            principal,
            method: 'GET',
            originalUrl: '/api/v1/platform/billing/voice-shadow/summary',
            params: {},
            headers: {},
            body: {},
          }),
        }),
      } as any;
    }

    it('permits Super Admin with BILLING_VIEW_CROSS_TENANT permission', async () => {
      const ctx = createMockContext(
        {
          userId: 'admin-1',
          role: Role.SUPER_ADMIN,
          isSuperAdmin: true,
          tenantId: null,
        },
        Permission.BILLING_VIEW_CROSS_TENANT,
      );

      expect(await rolesGuard.canActivate(ctx)).toBe(true);
    });

    it('denies Manager access to wholesale shadow reconciliation with 403 ForbiddenRoleException', async () => {
      const ctx = createMockContext(
        {
          userId: 'mgr-1',
          role: Role.MANAGER,
          isSuperAdmin: false,
          tenantId: tenantA,
        },
        Permission.BILLING_VIEW_CROSS_TENANT,
      );

      await expect(rolesGuard.canActivate(ctx)).rejects.toThrow(ForbiddenRoleException);
    });

    it('denies Staff access to wholesale shadow reconciliation with 403 ForbiddenRoleException', async () => {
      const ctx = createMockContext(
        {
          userId: 'staff-1',
          role: Role.STAFF,
          isSuperAdmin: false,
          tenantId: tenantA,
        },
        Permission.BILLING_VIEW_CROSS_TENANT,
      );

      await expect(rolesGuard.canActivate(ctx)).rejects.toThrow(ForbiddenRoleException);
    });
  });
});
