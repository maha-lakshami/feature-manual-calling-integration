import {
  Channel,
  CostSource,
  CostUnavailableReason,
  type ProviderCostResolution,
} from '@aiking/shared';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../common/tenant/tenant-context';
import { RatingEngineService } from './rating-engine.service';
import {
  ImmutabilityViolationException,
  RatingSnapshotService,
  type RecordRatingSnapshotInput,
} from './rating-snapshot.service';

describe('RatingSnapshotService — Historical Rating Snapshot Persistence', () => {
  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const TENANT_B = '22222222-2222-2222-2222-222222222222';

  let tenantContext: TenantContext;
  let ratingEngine: RatingEngineService;
  let inMemoryDb: Map<string, any>;
  let prismaMock: any;
  let snapshotService: RatingSnapshotService;

  beforeEach(() => {
    tenantContext = new TenantContext();
    ratingEngine = new RatingEngineService();
    inMemoryDb = new Map();

    prismaMock = {
      usageRatingSnapshot: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          const key = `${where.usage_rating_snapshot_tenant_usage_reference.tenantId}:${where.usage_rating_snapshot_tenant_usage_reference.usageReference}`;
          return inMemoryDb.get(key) ?? null;
        }),
        findUniqueOrThrow: jest.fn().mockImplementation(async ({ where }) => {
          const key = `${where.usage_rating_snapshot_tenant_usage_reference.tenantId}:${where.usage_rating_snapshot_tenant_usage_reference.usageReference}`;
          const found = inMemoryDb.get(key);
          if (!found) throw new Error('Not found');
          return found;
        }),
        create: jest.fn().mockImplementation(async ({ data }) => {
          const key = `${data.tenantId}:${data.usageReference}`;
          if (inMemoryDb.has(key)) {
            const error: any = new Error('Unique constraint violation');
            error.code = 'P2002';
            error.meta = { target: ['tenant_id', 'usage_reference'] };
            throw error;
          }
          const record = {
            id: `snap-${Math.random().toString(36).slice(2)}`,
            ...data,
            createdAt: new Date(),
          };
          inMemoryDb.set(key, record);
          return record;
        }),
        findMany: jest.fn().mockImplementation(async ({ where }) => {
          return Array.from(inMemoryDb.values()).filter(
            (r) =>
              r.tenantId === where.tenantId &&
              (!where.channel || r.channel === where.channel) &&
              (!where.provider || r.provider === where.provider),
          );
        }),
      },
    };

    snapshotService = new RatingSnapshotService(prismaMock as any, ratingEngine, tenantContext);
  });

  function runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.runWithTenant(
      {
        tenantId,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      fn,
    );
  }

  // ── 1. Snapshot preserves provider cost ────────────────────────────────────

  it('1. preserves exact provider cost in historical snapshot', async () => {
    await runWithTenant(TENANT_A, async () => {
      const input: RecordRatingSnapshotInput = {
        channel: Channel.CALL,
        provider: 'plivo',
        providerReference: 'plivo-call-1',
        quantity: 125, // seconds
        unit: 'second',
        currency: 'INR',
        providerCostPaise: 12000n, // ₹120.00
        costSource: CostSource.PROVIDER_USAGE,
        usageReference: 'call-ref-001',
      };

      const result = await snapshotService.recordSnapshot(input);
      expect(result.recorded).toBe(true);
      if (result.recorded) {
        expect(result.snapshot.providerCostPaise).toBe('12000');
        expect(result.snapshot.provider).toBe('plivo');
        expect(result.snapshot.quantity).toBe(125);
        expect(result.snapshot.unit).toBe('second');
      }
    });
  });

  // ── 2. Snapshot preserves markupBps ────────────────────────────────────────

  it('2. preserves exact markup basis points in historical snapshot', async () => {
    await runWithTenant(TENANT_A, async () => {
      const input: RecordRatingSnapshotInput = {
        channel: Channel.WHATSAPP,
        provider: 'meta',
        providerReference: 'wamid-1',
        quantity: 1,
        unit: 'message',
        currency: 'INR',
        providerCostPaise: 4000n, // ₹40.00
        markupBps: 2500, // 25.00%
        costSource: CostSource.RATE_CATALOG,
        usageReference: 'wa-ref-001',
      };

      const result = await snapshotService.recordSnapshot(input);
      expect(result.recorded).toBe(true);
      if (result.recorded) {
        expect(result.snapshot.markupBps).toBe(2500);
        expect(result.snapshot.markupAmountPaise).toBe('1000'); // 25% of 4000
      }
    });
  });

  // ── 3. Snapshot preserves customer charge ──────────────────────────────────

  it('3. preserves exact customer retail charge in historical snapshot', async () => {
    await runWithTenant(TENANT_A, async () => {
      const input: RecordRatingSnapshotInput = {
        channel: Channel.EMAIL,
        provider: 'ses',
        providerReference: 'ses-msg-1',
        quantity: 1,
        unit: 'message',
        currency: 'INR',
        providerCostPaise: 800n, // 800 paise wholesale
        markupBps: 2500, // 25% = 200 paise
        costSource: CostSource.PROVIDER_API,
        usageReference: 'email-ref-001',
      };

      const result = await snapshotService.recordSnapshot(input);
      expect(result.recorded).toBe(true);
      if (result.recorded) {
        expect(result.snapshot.customerChargePaise).toBe('1000'); // 800 + 200 = 1000
      }
    });
  });

  // ── 4. Later policy change does not change old snapshot ────────────────────

  it('4. guarantees later pricing policy changes do not alter historical snapshots', async () => {
    await runWithTenant(TENANT_A, async () => {
      const usageRef = 'call-historical-101';

      // Settled on Day 1 with 2500 bps (25%) markup
      const day1Result = await snapshotService.recordSnapshot({
        channel: Channel.CALL,
        provider: 'plivo',
        quantity: 60,
        unit: 'second',
        currency: 'INR',
        providerCostPaise: 10000n, // ₹100
        markupBps: 2500, // 25%
        costSource: CostSource.PROVIDER_USAGE,
        usageReference: usageRef,
      });

      expect(day1Result.recorded).toBe(true);
      if (day1Result.recorded) {
        expect(day1Result.snapshot.customerChargePaise).toBe('12500'); // ₹125
      }

      // Mock policy change to 5000 bps (50%) in engine
      jest.spyOn(ratingEngine, 'resolvePolicy').mockReturnValue({ markupBps: 5000 });

      // Reading back historical snapshot
      const retrieved = await snapshotService.getSnapshot(usageRef);
      expect(retrieved).not.toBeNull();
      // Must remain original ₹100 provider cost and ₹125 customer charge, NOT recomputed to ₹150
      expect(retrieved?.providerCostPaise).toBe('10000');
      expect(retrieved?.markupBps).toBe(2500);
      expect(retrieved?.customerChargePaise).toBe('12500');
    });
  });

  // ── 5. Duplicate usage reference creates no duplicate snapshot ─────────────

  it('5. prevents duplicate snapshots for the same usage reference (idempotent)', async () => {
    await runWithTenant(TENANT_A, async () => {
      const input: RecordRatingSnapshotInput = {
        channel: Channel.CALL,
        provider: 'plivo',
        quantity: 180,
        unit: 'second',
        currency: 'INR',
        providerCostPaise: 15000n,
        markupBps: 2500,
        costSource: CostSource.PROVIDER_USAGE,
        usageReference: 'duplicate-test-ref',
      };

      const first = await snapshotService.recordSnapshot(input);
      expect(first.recorded).toBe(true);
      if (first.recorded) {
        expect(first.isDuplicate).toBe(false);
      }

      // Second identical call
      const second = await snapshotService.recordSnapshot(input);
      expect(second.recorded).toBe(true);
      if (second.recorded && first.recorded) {
        expect(second.isDuplicate).toBe(true);
        expect(second.snapshot.id).toBe(first.snapshot.id);
      }

      expect(prismaMock.usageRatingSnapshot.create).toHaveBeenCalledTimes(1);
    });
  });

  // ── 6. Tenant isolation ───────────────────────────────────────────────────

  it('6. enforces strict tenant isolation for identical usage references', async () => {
    const commonRef = 'shared-job-key-999';

    // Tenant A records under commonRef
    await runWithTenant(TENANT_A, async () => {
      const resA = await snapshotService.recordSnapshot({
        channel: Channel.WHATSAPP,
        provider: 'meta',
        quantity: 1,
        unit: 'message',
        currency: 'INR',
        providerCostPaise: 3000n,
        costSource: CostSource.RATE_CATALOG,
        usageReference: commonRef,
      });
      expect(resA.recorded).toBe(true);
      if (resA.recorded) {
        expect(resA.snapshot.tenantId).toBe(TENANT_A);
      }
    });

    // Tenant B records under identical commonRef — must NOT collide or see Tenant A's record
    await runWithTenant(TENANT_B, async () => {
      const resB = await snapshotService.recordSnapshot({
        channel: Channel.WHATSAPP,
        provider: 'meta',
        quantity: 1,
        unit: 'message',
        currency: 'INR',
        providerCostPaise: 3000n,
        costSource: CostSource.RATE_CATALOG,
        usageReference: commonRef,
      });
      expect(resB.recorded).toBe(true);
      if (resB.recorded) {
        expect(resB.snapshot.tenantId).toBe(TENANT_B);
        expect(resB.isDuplicate).toBe(false);
      }

      const foundB = await snapshotService.getSnapshot(commonRef);
      expect(foundB?.tenantId).toBe(TENANT_B);
    });
  });

  // ── 7. BigInt monetary values preserved ───────────────────────────────────

  it('7. preserves large BigInt monetary values without precision loss', async () => {
    await runWithTenant(TENANT_A, async () => {
      // 50 trillion paise (exceeds Number.MAX_SAFE_INTEGER)
      const largeCostPaise = 50_000_000_000_000_000n;

      const result = await snapshotService.recordSnapshot({
        channel: Channel.CALL,
        provider: 'plivo',
        quantity: 1000000,
        unit: 'second',
        currency: 'INR',
        providerCostPaise: largeCostPaise,
        markupBps: 2500,
        costSource: CostSource.PROVIDER_USAGE,
        usageReference: 'large-bigint-ref',
      });

      expect(result.recorded).toBe(true);
      if (result.recorded) {
        expect(result.snapshot.providerCostPaise).toBe('50000000000000000');
        expect(result.snapshot.markupAmountPaise).toBe('12500000000000000');
        expect(result.snapshot.customerChargePaise).toBe('62500000000000000');
      }
    });
  });

  // ── 8. Currency preserved ─────────────────────────────────────────────────

  it('8. preserves currency throughout snapshot storage and serialization', async () => {
    await runWithTenant(TENANT_A, async () => {
      const usdResult = await snapshotService.recordSnapshot({
        channel: Channel.CALL,
        provider: 'twilio',
        quantity: 60,
        unit: 'second',
        currency: 'USD',
        providerCostPaise: 500n,
        costSource: CostSource.PROVIDER_API,
        usageReference: 'currency-usd-ref',
      });

      expect(usdResult.recorded).toBe(true);
      if (usdResult.recorded) {
        expect(usdResult.snapshot.currency).toBe('USD');
      }
    });
  });

  // ── 9. Cost unavailable does not create fake snapshot ─────────────────────

  it('9. does not create fake snapshot when provider cost is unavailable', async () => {
    await runWithTenant(TENANT_A, async () => {
      const unavailableResolution: ProviderCostResolution = {
        available: false,
        provider: 'plivo',
        channel: Channel.CALL,
        reason: CostUnavailableReason.NOT_SUPPORTED_BY_PROVIDER,
        message: 'Plivo live API does not provide real-time wholesale cost',
      };

      const result = await snapshotService.recordSnapshot({
        channel: Channel.CALL,
        provider: 'plivo',
        quantity: 60,
        unit: 'second',
        currency: 'INR',
        costResolution: unavailableResolution,
        usageReference: 'unavailable-cost-ref',
      });

      expect(result.recorded).toBe(false);
      if (!result.recorded) {
        expect(result.reason).toBe('COST_UNAVAILABLE');
        expect(result.message).toContain('Plivo live API does not provide');
      }

      expect(prismaMock.usageRatingSnapshot.create).not.toHaveBeenCalled();
    });
  });

  // ── 10. Historical record cannot be silently overwritten ──────────────────

  it('10. rejects attempts to silently overwrite historical snapshot with conflicting values', async () => {
    await runWithTenant(TENANT_A, async () => {
      const usageRef = 'tamper-resistant-ref';

      // Original recording
      const first = await snapshotService.recordSnapshot({
        channel: Channel.CALL,
        provider: 'plivo',
        quantity: 60,
        unit: 'second',
        currency: 'INR',
        providerCostPaise: 10000n,
        markupBps: 2500,
        costSource: CostSource.PROVIDER_USAGE,
        usageReference: usageRef,
      });
      expect(first.recorded).toBe(true);

      // Attempted overwrite with different cost (e.g. 5000n instead of 10000n)
      await expect(
        snapshotService.recordSnapshot({
          channel: Channel.CALL,
          provider: 'plivo',
          quantity: 60,
          unit: 'second',
          currency: 'INR',
          providerCostPaise: 5000n, // CONFLICTING VALUE
          markupBps: 2500,
          costSource: CostSource.PROVIDER_USAGE,
          usageReference: usageRef,
        }),
      ).rejects.toThrow(ImmutabilityViolationException);

      // Attempted overwrite with different markup
      await expect(
        snapshotService.recordSnapshot({
          channel: Channel.CALL,
          provider: 'plivo',
          quantity: 60,
          unit: 'second',
          currency: 'INR',
          providerCostPaise: 10000n,
          markupBps: 5000, // CONFLICTING MARKUP
          costSource: CostSource.PROVIDER_USAGE,
          usageReference: usageRef,
        }),
      ).rejects.toThrow(ImmutabilityViolationException);
    });
  });

  // ── 11. Concurrency-safe unique conflict race handling ─────────────────────

  it('11. handles concurrent unique race conditions safely and confirms immutability', async () => {
    await runWithTenant(TENANT_A, async () => {
      const usageRef = 'race-condition-ref';
      const input: RecordRatingSnapshotInput = {
        channel: Channel.WHATSAPP,
        provider: 'meta',
        quantity: 1,
        unit: 'message',
        currency: 'INR',
        providerCostPaise: 2500n,
        markupBps: 2500,
        costSource: CostSource.RATE_CATALOG,
        usageReference: usageRef,
      };

      // Simulate findUnique returning null (race window), but create throwing P2002 because another process committed first
      prismaMock.usageRatingSnapshot.findUnique.mockResolvedValueOnce(null);
      prismaMock.usageRatingSnapshot.create.mockImplementationOnce(() => {
        const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.10.0',
          meta: { target: ['tenant_id', 'usage_reference'] },
        });
        // Simultaneously populate inMemoryDb as if the rival process committed
        inMemoryDb.set(`${TENANT_A}:${usageRef}`, {
          id: 'rival-winner-id',
          tenantId: TENANT_A,
          channel: Channel.WHATSAPP,
          provider: 'meta',
          providerReference: null,
          quantity: 1,
          unit: 'message',
          currency: 'INR',
          providerCostPaise: 2500n,
          markupBps: 2500,
          markupAmountPaise: 625n,
          customerChargePaise: 3125n,
          costSource: CostSource.RATE_CATALOG,
          policyReference: null,
          usageReference: usageRef,
          metadata: {},
          ratedAt: new Date(),
          settledAt: new Date(),
          createdAt: new Date(),
        });
        throw err;
      });

      const result = await snapshotService.recordSnapshot(input);
      expect(result.recorded).toBe(true);
      if (result.recorded) {
        expect(result.isDuplicate).toBe(true);
        expect(result.snapshot.id).toBe('rival-winner-id');
        expect(result.snapshot.customerChargePaise).toBe('3125');
      }
    });
  });

  // ── 12. SettledAt and RatedAt timestamps preserved ─────────────────────────

  it('12. preserves ratedAt and settledAt timestamps correctly', async () => {
    await runWithTenant(TENANT_A, async () => {
      const ratedTime = new Date('2026-09-01T10:00:00.000Z');
      const settledTime = new Date('2026-09-01T10:05:00.000Z');

      const result = await snapshotService.recordSnapshot({
        channel: Channel.CALL,
        provider: 'plivo',
        quantity: 300, // 300 seconds
        unit: 'second',
        currency: 'INR',
        providerCostPaise: 20000n,
        costSource: CostSource.PROVIDER_USAGE,
        usageReference: 'timestamp-test-ref',
        ratedAt: ratedTime,
        settledAt: settledTime,
      });

      expect(result.recorded).toBe(true);
      if (result.recorded) {
        expect(result.snapshot.ratedAt).toBe(ratedTime.toISOString());
        expect(result.snapshot.settledAt).toBe(settledTime.toISOString());
      }
    });
  });

  // ── 13. Sub-paisa micro-paise rating snapshot persistence ──────────────────

  it('13. records exact sub-paisa micro-paise economics in snapshot', async () => {
    await runWithTenant(TENANT_A, async () => {
      // 1 email @ 840,000 micro-paise (0.84 paise) + 2500 bps (25%) markup
      const result = await snapshotService.recordSnapshot({
        channel: Channel.EMAIL,
        provider: 'ses',
        quantity: 1,
        unit: 'email',
        currency: 'INR',
        rateMicroPaise: 840_000n,
        providerCostMicroPaise: 840_000n,
        costSource: CostSource.RATE_CATALOG,
        usageReference: 'email-sub-paisa-1',
      });

      expect(result.recorded).toBe(true);
      if (result.recorded) {
        expect(result.snapshot.rateMicroPaise).toBe('840000');
        expect(result.snapshot.providerCostMicroPaise).toBe('840000');
        expect(result.snapshot.markupAmountMicroPaise).toBe('210000');
        expect(result.snapshot.retailAmountMicroPaise).toBe('1050000');
        // Final integer customer charge rounded once: ceil(1.05) = 2 paise
        expect(result.snapshot.customerChargePaise).toBe('2');
        expect(result.snapshot.providerCostPaise).toBe('1');
      }
    });
  });

  // ── 14. Immutability violation on conflicting micro-paise ──────────────────

  it('14. throws ImmutabilityViolationException on conflicting micro-paise values', async () => {
    await runWithTenant(TENANT_A, async () => {
      await snapshotService.recordSnapshot({
        channel: Channel.EMAIL,
        provider: 'ses',
        quantity: 1,
        unit: 'email',
        currency: 'INR',
        rateMicroPaise: 840_000n,
        providerCostMicroPaise: 840_000n,
        costSource: CostSource.RATE_CATALOG,
        usageReference: 'email-conflict-test',
      });

      // Attempt to re-record same usageReference with different micro-paise
      await expect(
        snapshotService.recordSnapshot({
          channel: Channel.EMAIL,
          provider: 'ses',
          quantity: 1,
          unit: 'email',
          currency: 'INR',
          rateMicroPaise: 900_000n,
          providerCostMicroPaise: 900_000n,
          costSource: CostSource.RATE_CATALOG,
          usageReference: 'email-conflict-test',
        }),
      ).rejects.toThrow(ImmutabilityViolationException);
    });
  });
});
