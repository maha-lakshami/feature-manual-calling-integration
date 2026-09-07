import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Channel,
  CostSource,
  DEFAULT_MARKUP_BPS,
  paiseToMicroPaise,
  type ProviderCostResolution,
  type UsageRatingSnapshotDto,
} from '@aiking/shared';
import { isUniqueViolation, PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { RatingEngineService } from './rating-engine.service';

export class ImmutabilityViolationException extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ImmutabilityViolationException';
  }
}

export interface RecordRatingSnapshotInput {
  readonly channel: Channel;
  readonly provider: string;
  readonly providerReference?: string | null;
  /** Exact integer quantity of billing units (seconds, messages, characters, etc.) */
  readonly quantity: number;
  /** Unit descriptor (e.g. 'second', 'minute', 'message') */
  readonly unit: string;
  readonly currency?: string;

  /** Authoritative wholesale provider cost in paise. Nullable if passed via costResolution or providerCostMicroPaise. */
  readonly providerCostPaise?: bigint | null;

  /** Authoritative wholesale provider cost in micro-paise (1 paisa = 1,000,000 micro-paise). */
  readonly providerCostMicroPaise?: bigint | null;

  /** Wholesale unit rate in micro-paise. */
  readonly rateMicroPaise?: bigint | null;

  /** Optional cost resolution result from ProviderCostResolver. */
  readonly costResolution?: ProviderCostResolution;

  /** Markup in basis points (e.g. 2500 = 25%). Defaults to policy resolution. */
  readonly markupBps?: number;

  readonly costSource?: CostSource;
  readonly policyReference?: string | null;

  /** Authoritative usage reference / idempotency key, unique per tenant. */
  readonly usageReference: string;

  readonly metadata?: Record<string, unknown>;
  readonly ratedAt?: Date;
  readonly settledAt?: Date;
}

export type RecordRatingSnapshotResult =
  | {
      readonly recorded: true;
      readonly isDuplicate: boolean;
      readonly snapshot: UsageRatingSnapshotDto;
    }
  | {
      readonly recorded: false;
      readonly reason: 'COST_UNAVAILABLE';
      readonly message: string;
    };

export interface ListSnapshotsFilter {
  readonly channel?: Channel;
  readonly provider?: string;
  readonly limit?: number;
}

/**
 * Service managing immutable historical usage rating snapshots.
 *
 * Enforces:
 *   - Absolute historical immutability: once settled, snapshots cannot be updated or deleted.
 *   - Strict tenant isolation via trusted ALS context.
 *   - Concurrency-safe idempotency handling unique-constraint races without data mutation.
 *   - End-to-end BigInt micro-paise precision with single-rounding customer retail settlement.
 *   - Refusal to record fake costs when provider costs are unavailable.
 */
@Injectable()
export class RatingSnapshotService {
  private readonly logger = new Logger(RatingSnapshotService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly ratingEngine: RatingEngineService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Record a settled usage rating snapshot.
   *
   * Idempotent on (tenantId, usageReference). If a record already exists, it verifies
   * that immutable financial values match and returns the existing snapshot.
   * If wholesale cost is unavailable, it returns recorded: false without fabricating data.
   */
  async recordSnapshot(input: RecordRatingSnapshotInput): Promise<RecordRatingSnapshotResult> {
    const tenantId = this.tenantContext.requireTenantId('ratingSnapshot.recordSnapshot');

    // 1. Validate usage reference
    if (!input.usageReference || !input.usageReference.trim()) {
      throw new Error('usageReference is required for rating snapshot persistence');
    }

    // 2. Validate quantity
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new Error(`Quantity must be a positive integer, received: ${input.quantity}`);
    }

    // 3. Resolve wholesale cost in micro-paise
    let providerCostMicroPaise: bigint | null = null;
    let rateMicroPaise: bigint | null = input.rateMicroPaise ?? null;
    let costSource: CostSource = input.costSource ?? CostSource.PROVIDER_USAGE;

    if (input.costResolution) {
      if (!input.costResolution.available) {
        this.logger.warn(
          `Snapshot skipped for reference "${input.usageReference}": provider cost unavailable (${input.costResolution.reason})`,
        );
        return {
          recorded: false,
          reason: 'COST_UNAVAILABLE',
          message: input.costResolution.message ?? `Provider cost unavailable: ${input.costResolution.reason}`,
        };
      }
      providerCostMicroPaise =
        input.costResolution.cost.costMicroPaise ?? paiseToMicroPaise(input.costResolution.cost.costPaise);
      rateMicroPaise = input.costResolution.cost.rateMicroPaise ?? null;
      costSource = input.costResolution.cost.source;
    } else if (input.providerCostMicroPaise !== undefined && input.providerCostMicroPaise !== null) {
      providerCostMicroPaise = input.providerCostMicroPaise;
    } else if (input.providerCostPaise !== undefined && input.providerCostPaise !== null) {
      providerCostMicroPaise = paiseToMicroPaise(input.providerCostPaise);
    }

    if (providerCostMicroPaise === null || providerCostMicroPaise === undefined) {
      this.logger.warn(
        `Snapshot skipped for reference "${input.usageReference}": no authoritative provider cost provided`,
      );
      return {
        recorded: false,
        reason: 'COST_UNAVAILABLE',
        message: 'No authoritative wholesale provider cost provided',
      };
    }

    const currency = (input.currency ?? 'INR').toUpperCase();

    // 4. Resolve markup and calculate aggregate rated charge in micro-paise
    const effectivePolicy =
      input.markupBps !== undefined
        ? { markupBps: input.markupBps }
        : this.ratingEngine.resolvePolicy(tenantId, input.channel);

    const markupBps = effectivePolicy.markupBps ?? DEFAULT_MARKUP_BPS;

    // Single-rounding rating pipeline: aggregate micro-paise -> apply markup -> round ONCE to integer paise
    const rated = this.ratingEngine.calculateMicroPaise(providerCostMicroPaise, currency, markupBps);

    const now = new Date();
    const ratedAt = input.ratedAt ?? now;
    const settledAt = input.settledAt ?? now;

    // 5. Check if snapshot already exists for (tenantId, usageReference)
    const existing = await this.prisma.usageRatingSnapshot.findUnique({
      where: {
        usage_rating_snapshot_tenant_usage_reference: {
          tenantId,
          usageReference: input.usageReference,
        },
      },
    });

    if (existing) {
      this.verifyImmutableMatch(existing, {
        providerCostPaise: rated.providerCostPaise,
        markupBps,
        customerChargePaise: rated.customerChargePaise,
        channel: input.channel,
        provider: input.provider,
        quantity: input.quantity,
        currency,
        providerCostMicroPaise: rated.providerCostMicroPaise,
      });
      return { recorded: true, isDuplicate: true, snapshot: this.toDto(existing) };
    }

    // 6. Persist snapshot with concurrency-safe race handling
    try {
      const created = await this.prisma.usageRatingSnapshot.create({
        data: {
          tenantId,
          channel: input.channel,
          provider: input.provider,
          providerReference: input.providerReference ?? null,
          quantity: input.quantity,
          unit: input.unit,
          currency,
          rateMicroPaise,
          providerCostMicroPaise: rated.providerCostMicroPaise,
          markupAmountMicroPaise: rated.markupAmountMicroPaise,
          retailAmountMicroPaise: rated.retailAmountMicroPaise,
          providerCostPaise: rated.providerCostPaise,
          markupBps,
          markupAmountPaise: rated.markupAmountPaise,
          customerChargePaise: rated.customerChargePaise,
          costSource,
          policyReference: input.policyReference ?? null,
          usageReference: input.usageReference,
          metadata: (input.metadata ?? {}) as object,
          ratedAt,
          settledAt,
        },
      });

      return { recorded: true, isDuplicate: false, snapshot: this.toDto(created) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Concurrency race: another worker won the race
        const winner = await this.prisma.usageRatingSnapshot.findUniqueOrThrow({
          where: {
            usage_rating_snapshot_tenant_usage_reference: {
              tenantId,
              usageReference: input.usageReference,
            },
          },
        });
        this.verifyImmutableMatch(winner, {
          providerCostPaise: rated.providerCostPaise,
          markupBps,
          customerChargePaise: rated.customerChargePaise,
          channel: input.channel,
          provider: input.provider,
          quantity: input.quantity,
          currency,
          providerCostMicroPaise: rated.providerCostMicroPaise,
        });
        return { recorded: true, isDuplicate: true, snapshot: this.toDto(winner) };
      }
      throw error;
    }
  }

  /**
   * Retrieve an existing snapshot by its authoritative usage reference.
   * Scoped to the active trusted tenant.
   */
  async getSnapshot(usageReference: string): Promise<UsageRatingSnapshotDto | null> {
    const tenantId = this.tenantContext.requireTenantId('ratingSnapshot.getSnapshot');
    const row = await this.prisma.usageRatingSnapshot.findUnique({
      where: {
        usage_rating_snapshot_tenant_usage_reference: {
          tenantId,
          usageReference,
        },
      },
    });
    return row ? this.toDto(row) : null;
  }

  /**
   * List historical snapshots for the active trusted tenant.
   */
  async listSnapshots(filter?: ListSnapshotsFilter): Promise<UsageRatingSnapshotDto[]> {
    const tenantId = this.tenantContext.requireTenantId('ratingSnapshot.listSnapshots');
    const rows = await this.prisma.usageRatingSnapshot.findMany({
      where: {
        tenantId,
        channel: filter?.channel,
        provider: filter?.provider,
      },
      orderBy: { settledAt: 'desc' },
      take: Math.min(100, Math.max(1, filter?.limit ?? 50)),
    });
    return rows.map((r) => this.toDto(r));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Verify that existing row has identical immutable financial properties.
   * Throws ImmutabilityViolationException if conflicting values are detected.
   */
  private verifyImmutableMatch(
    existing: {
      usageReference: string;
      providerCostPaise: bigint;
      markupBps: number;
      customerChargePaise: bigint;
      channel: string;
      provider: string;
      quantity: number;
      currency: string;
      providerCostMicroPaise?: bigint | null;
    },
    expected: {
      providerCostPaise: bigint;
      markupBps: number;
      customerChargePaise: bigint;
      channel: string;
      provider: string;
      quantity: number;
      currency: string;
      providerCostMicroPaise?: bigint | null;
    },
  ): void {
    const microPaiseConflict =
      existing.providerCostMicroPaise !== null &&
      existing.providerCostMicroPaise !== undefined &&
      expected.providerCostMicroPaise !== null &&
      expected.providerCostMicroPaise !== undefined &&
      existing.providerCostMicroPaise !== expected.providerCostMicroPaise;

    if (
      existing.providerCostPaise !== expected.providerCostPaise ||
      existing.markupBps !== expected.markupBps ||
      existing.customerChargePaise !== expected.customerChargePaise ||
      existing.channel !== expected.channel ||
      existing.provider !== expected.provider ||
      existing.quantity !== expected.quantity ||
      existing.currency !== expected.currency ||
      microPaiseConflict
    ) {
      throw new ImmutabilityViolationException(
        `Usage rating snapshot for reference "${existing.usageReference}" already exists with conflicting immutable values`,
        {
          existing: {
            costPaise: existing.providerCostPaise.toString(),
            costMicroPaise: existing.providerCostMicroPaise?.toString(),
            markupBps: existing.markupBps,
            chargePaise: existing.customerChargePaise.toString(),
            channel: existing.channel,
            provider: existing.provider,
            quantity: existing.quantity,
            currency: existing.currency,
          },
          attempted: {
            costPaise: expected.providerCostPaise.toString(),
            costMicroPaise: expected.providerCostMicroPaise?.toString(),
            markupBps: expected.markupBps,
            chargePaise: expected.customerChargePaise.toString(),
            channel: expected.channel,
            provider: expected.provider,
            quantity: expected.quantity,
            currency: expected.currency,
          },
        },
      );
    }
  }

  private toDto(row: {
    id: string;
    tenantId: string;
    channel: Channel;
    provider: string;
    providerReference: string | null;
    quantity: number;
    unit: string;
    currency: string;
    rateMicroPaise?: bigint | null;
    providerCostMicroPaise?: bigint | null;
    markupAmountMicroPaise?: bigint | null;
    retailAmountMicroPaise?: bigint | null;
    providerCostPaise: bigint;
    markupBps: number;
    markupAmountPaise: bigint;
    customerChargePaise: bigint;
    costSource: CostSource;
    policyReference: string | null;
    usageReference: string;
    metadata: unknown;
    ratedAt: Date;
    settledAt: Date;
    createdAt: Date;
  }): UsageRatingSnapshotDto {
    return {
      id: row.id,
      tenantId: row.tenantId,
      channel: row.channel,
      provider: row.provider,
      providerReference: row.providerReference,
      quantity: row.quantity,
      unit: row.unit,
      currency: row.currency,
      rateMicroPaise: row.rateMicroPaise ? row.rateMicroPaise.toString() : null,
      providerCostMicroPaise: row.providerCostMicroPaise ? row.providerCostMicroPaise.toString() : null,
      markupAmountMicroPaise: row.markupAmountMicroPaise ? row.markupAmountMicroPaise.toString() : null,
      retailAmountMicroPaise: row.retailAmountMicroPaise ? row.retailAmountMicroPaise.toString() : null,
      providerCostPaise: row.providerCostPaise.toString(),
      markupBps: row.markupBps,
      markupAmountPaise: row.markupAmountPaise.toString(),
      customerChargePaise: row.customerChargePaise.toString(),
      costSource: row.costSource,
      policyReference: row.policyReference,
      usageReference: row.usageReference,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      ratedAt: row.ratedAt.toISOString(),
      settledAt: row.settledAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
