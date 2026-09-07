import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CallStatus,
  Channel,
  calculateVarianceBps,
  type ActivationGateCheckItem,
  type ActivationGateReportDto,
  type ActivationGateThresholds,
  type DestinationCoverageSummary,
  type LiveQueueHealthDto,
  type RateCoverageMatchType,
  type RateCoverageReportDto,
  type ReconciliationSummaryDto,
} from '@aiking/shared';

import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { QueueService } from '../queue/queue.service';
import { RateCatalogService } from '../rate-catalog/rate-catalog.service';

export interface ReconciliationFilter {
  tenantId?: string;
  fromDate?: Date;
  toDate?: Date;
}

@Injectable()
export class VoiceShadowReconciliationService {
  private readonly logger = new Logger(VoiceShadowReconciliationService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly rateCatalog: RateCatalogService,
    private readonly queue: QueueService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Platform-wide or filtered voice shadow reconciliation summary.
   * Runs under trusted platform scope (runAsSuperAdmin).
   * All pricing variance totals and averages are derived strictly from RATED rows.
   */
  async getReconciliationSummary(filter?: ReconciliationFilter): Promise<ReconciliationSummaryDto> {
    return this.tenantContext.runAsSuperAdmin('platform voice shadow reconciliation', async () => {
      const where: Record<string, unknown> = {};

      if (filter?.tenantId) {
        where.tenantId = filter.tenantId;
      }

      if (filter?.fromDate || filter?.toDate) {
        where.occurredAt = {
          ...(filter.fromDate ? { gte: filter.fromDate } : {}),
          ...(filter.toDate ? { lte: filter.toDate } : {}),
        };
      }

      const rows = await this.prisma.callShadowRating.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
      });

      const conflictCount = await this.prisma.callShadowRatingConflict.count({
        where: filter?.tenantId ? { tenantId: filter.tenantId } : {},
      });

      const totalCallsEvaluated = rows.length;
      const ratedRows = rows.filter((r) => r.status === 'RATED');
      const costUnavailableRows = rows.filter((r) => r.status === 'COST_UNAVAILABLE');
      const usageNotFoundRows = rows.filter((r) => r.status === 'USAGE_NOT_FOUND');
      const providerUnknownRows = rows.filter((r) => r.status === 'PROVIDER_UNKNOWN');

      // USAGE_NOT_FOUND semantics: missing vs zero authoritative BillDuration
      const missingAuthoritativeBillDurationCount = usageNotFoundRows.filter(
        (r) => r.billableSeconds === null,
      ).length;
      const zeroAuthoritativeBillDurationCount = usageNotFoundRows.filter(
        (r) => r.billableSeconds === 0,
      ).length;
      const usageNotFoundLegacyChargePaise = usageNotFoundRows.reduce(
        (acc, r) => acc + r.legacyCustomerChargePaise,
        0n,
      );

      // Financial calculations derived STRICTLY from RATED rows
      let ratedLegacyTotalPaise = 0n;
      let ratedShadowTotalPaise = 0n;
      let signedDifferencePaise = 0n;
      let absoluteDifferencePaise = 0n;
      let minDifferencePaise = 0n;
      let maxDifferencePaise = 0n;

      if (ratedRows.length > 0) {
        minDifferencePaise = ratedRows[0].differencePaise ?? 0n;
        maxDifferencePaise = ratedRows[0].differencePaise ?? 0n;

        for (const r of ratedRows) {
          ratedLegacyTotalPaise += r.legacyCustomerChargePaise;
          const shadow = r.shadowCustomerChargePaise ?? 0n;
          ratedShadowTotalPaise += shadow;

          const diff = r.differencePaise ?? shadow - r.legacyCustomerChargePaise;
          signedDifferencePaise += diff;

          const absDiff = diff < 0n ? -diff : diff;
          absoluteDifferencePaise += absDiff;

          if (diff < minDifferencePaise) minDifferencePaise = diff;
          if (diff > maxDifferencePaise) maxDifferencePaise = diff;
        }
      }

      const ratedCount = ratedRows.length;
      const avgLegacyChargePaise =
        ratedCount > 0 ? ratedLegacyTotalPaise / BigInt(ratedCount) : 0n;
      const avgShadowChargePaise =
        ratedCount > 0 ? ratedShadowTotalPaise / BigInt(ratedCount) : 0n;

      const varianceBps = calculateVarianceBps(signedDifferencePaise, ratedLegacyTotalPaise);

      return {
        totalCallsEvaluated,
        ratedCount,
        costUnavailableCount: costUnavailableRows.length,
        usageNotFoundCount: usageNotFoundRows.length,
        missingAuthoritativeBillDurationCount,
        zeroAuthoritativeBillDurationCount,
        usageNotFoundLegacyChargePaise: usageNotFoundLegacyChargePaise.toString(),
        providerUnknownCount: providerUnknownRows.length,
        conflictCount,

        ratedLegacyTotalPaise: ratedLegacyTotalPaise.toString(),
        ratedShadowTotalPaise: ratedShadowTotalPaise.toString(),
        signedDifferencePaise: signedDifferencePaise.toString(),
        absoluteDifferencePaise: absoluteDifferencePaise.toString(),
        minDifferencePaise: minDifferencePaise.toString(),
        maxDifferencePaise: maxDifferencePaise.toString(),
        avgLegacyChargePaise: avgLegacyChargePaise.toString(),
        avgShadowChargePaise: avgShadowChargePaise.toString(),
        varianceBps,
      };
    });
  }

  /**
   * Rate coverage analysis for Voice destinations.
   * Reuses the authoritative RateCatalogService resolution primitive directly.
   */
  async getRateCoverageReport(options?: { provider?: string }): Promise<RateCoverageReportDto> {
    const provider = (options?.provider ?? 'plivo').toLowerCase();

    return this.tenantContext.runAsSuperAdmin('rate coverage analysis', async () => {
      // Find all distinct destination phone numbers dialed under this provider
      const calls = await this.prisma.call.findMany({
        where: {
          provider,
          status: { in: [CallStatus.COMPLETED, CallStatus.SUMMARIZING] },
        },
        select: { toNumber: true },
        distinct: ['toNumber'],
      });

      const now = new Date();
      const destinations: DestinationCoverageSummary[] = [];

      let specificMatchCount = 0;
      let wildcardMatchCount = 0;
      let uncoveredCount = 0;
      let effectiveDateGapCount = 0;
      const unitCurrencyMismatchCount = 0;

      for (const call of calls) {
        const dest = call.toNumber;
        const totalCalls = await this.prisma.call.count({
          where: { provider, toNumber: dest },
        });

        // Reuses authoritative RateCatalogService resolution logic
        const resolved = await this.rateCatalog.resolveRate({
          provider,
          channel: Channel.CALL,
          destination: dest,
          unit: 'second',
          currency: 'INR',
          occurredAt: now,
        });

        if (resolved) {
          const isWildcard = resolved.destinationPattern === '*';
          if (isWildcard) {
            wildcardMatchCount++;
          } else {
            specificMatchCount++;
          }

          destinations.push({
            destination: dest,
            totalCalls,
            matchType: isWildcard ? 'wildcard' : 'specific',
            matchedRateId: resolved.id,
            matchedPattern: resolved.destinationPattern,
            rateMicroPaise: resolved.rateMicroPaise.toString(),
          });
        } else {
          // Check whether unrated because of an effective-date gap vs completely uncovered
          const existingForPattern = await this.prisma.providerRate.findFirst({
            where: {
              provider,
              channel: Channel.CALL,
              unit: 'second',
              currency: 'INR',
              active: true,
            },
          });

          const matchType: RateCoverageMatchType = existingForPattern
            ? 'effective_date_gap'
            : 'uncovered';

          if (matchType === 'effective_date_gap') {
            effectiveDateGapCount++;
          } else {
            uncoveredCount++;
          }

          destinations.push({
            destination: dest,
            totalCalls,
            matchType,
            matchedRateId: null,
            matchedPattern: null,
            rateMicroPaise: null,
          });
        }
      }

      return {
        provider,
        totalDestinationsEvaluated: calls.length,
        specificMatchCount,
        wildcardMatchCount,
        uncoveredCount,
        effectiveDateGapCount,
        unitCurrencyMismatchCount,
        destinations,
      };
    });
  }

  /**
   * Operational live queue health signal.
   */
  async getLiveQueueHealth(): Promise<LiveQueueHealthDto> {
    const isReady = await this.queue.checkReadiness();
    const pendingJobs = await this.queue.pendingCount();

    return {
      driver: this.queue.driverKind,
      isReady,
      pendingJobs,
      registeredQueues: this.queue.registeredQueues,
    };
  }

  /**
   * Evaluates the objective Voice Activation Gate criteria.
   * Returns pass/fail status and specific blocking reasons.
   */
  async evaluateActivationGate(thresholds?: ActivationGateThresholds): Promise<ActivationGateReportDto> {
    const maxConflicts = thresholds?.maxConflictsAllowed ?? 0;
    const maxUnknownProviders = thresholds?.maxUnknownProvidersAllowed ?? 0;
    const minCoveragePercent = thresholds?.minResolvedRateCoveragePercent ?? 100;
    const minSampleCount = thresholds?.minSampleCount ?? 0;

    const summary = await this.getReconciliationSummary();
    const coverage = await this.getRateCoverageReport();
    const queueHealth = await this.getLiveQueueHealth();

    const checks: ActivationGateCheckItem[] = [];
    const blockingReasons: string[] = [];

    // 1. Zero durable reconciliation conflicts
    const conflictsPassed = summary.conflictCount <= maxConflicts;
    checks.push({
      name: 'Zero Reconciliation Conflicts',
      passed: conflictsPassed,
      actual: summary.conflictCount,
      expected: `<= ${maxConflicts}`,
      details: conflictsPassed
        ? 'No conflicting duplicate replay attempts recorded.'
        : `${summary.conflictCount} duplicate replays carried conflicting immutable values.`,
    });
    if (!conflictsPassed) {
      blockingReasons.push(`Durable reconciliation conflicts detected: ${summary.conflictCount}`);
    }

    // 2. Zero unknown providers for new calls
    const unknownProvidersPassed = summary.providerUnknownCount <= maxUnknownProviders;
    checks.push({
      name: 'Zero Unknown Providers (New Calls)',
      passed: unknownProvidersPassed,
      actual: summary.providerUnknownCount,
      expected: `<= ${maxUnknownProviders}`,
      details: unknownProvidersPassed
        ? 'All calls have known originating telephony providers.'
        : `${summary.providerUnknownCount} calls have unknown provider identity.`,
    });
    if (!unknownProvidersPassed) {
      blockingReasons.push(`Unknown provider calls present: ${summary.providerUnknownCount}`);
    }

    // 3. 100% Rate Catalog Coverage
    const resolvedDestinations = coverage.specificMatchCount + coverage.wildcardMatchCount;
    const coveragePercent =
      coverage.totalDestinationsEvaluated === 0
        ? 100
        : Math.round((resolvedDestinations / coverage.totalDestinationsEvaluated) * 100);
    const coveragePassed = coveragePercent >= minCoveragePercent;
    checks.push({
      name: 'Wholesale Rate Coverage',
      passed: coveragePassed,
      actual: `${coveragePercent}%`,
      expected: `>= ${minCoveragePercent}%`,
      details: `${resolvedDestinations} of ${coverage.totalDestinationsEvaluated} destinations resolved (${coverage.specificMatchCount} prefix, ${coverage.wildcardMatchCount} wildcard, ${coverage.uncoveredCount} uncovered).`,
    });
    if (!coveragePassed) {
      blockingReasons.push(
        `Rate catalog coverage is ${coveragePercent}%, below required ${minCoveragePercent}%. Uncovered: ${coverage.uncoveredCount}`,
      );
    }

    // 4. Rate effective date gaps
    const dateGapsPassed = coverage.effectiveDateGapCount === 0;
    checks.push({
      name: 'No Unexplained Effective Date Gaps',
      passed: dateGapsPassed,
      actual: coverage.effectiveDateGapCount,
      expected: 0,
      details: dateGapsPassed
        ? 'No destinations suffered effective-date gaps.'
        : `${coverage.effectiveDateGapCount} destinations have rates with expired or gapped effective dates.`,
    });
    if (!dateGapsPassed) {
      blockingReasons.push(`Effective-date gaps detected for ${coverage.effectiveDateGapCount} destinations.`);
    }

    // 5. Configurable Sample Size
    const samplePassed = summary.ratedCount >= minSampleCount;
    checks.push({
      name: 'Evaluation Sample Size',
      passed: samplePassed,
      actual: summary.ratedCount,
      expected: `>= ${minSampleCount}`,
      details: `Evaluated ${summary.ratedCount} RATED calls against required ${minSampleCount}.`,
    });
    if (!samplePassed) {
      blockingReasons.push(
        `RATED sample count (${summary.ratedCount}) is below required minimum threshold (${minSampleCount}).`,
      );
    }

    // 6. Live Queue Health
    const queuePassed = queueHealth.isReady;
    checks.push({
      name: 'Operational Queue Health',
      passed: queuePassed,
      actual: queueHealth.isReady ? 'READY' : 'NOT_READY',
      expected: 'READY',
      details: `Driver: ${queueHealth.driver}, Pending jobs: ${queueHealth.pendingJobs}`,
    });
    if (!queuePassed) {
      blockingReasons.push('Queue driver readiness check failed.');
    }

    const passedChecks = checks.filter((c) => c.passed).length;
    const status = blockingReasons.length === 0 ? 'READY_FOR_ACTIVATION_REVIEW' : 'NOT_READY';

    return {
      status,
      passedChecks,
      totalChecks: checks.length,
      checks,
      blockingReasons,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
