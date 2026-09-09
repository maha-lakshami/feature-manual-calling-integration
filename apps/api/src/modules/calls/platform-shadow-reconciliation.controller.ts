import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  Role,
  type ActivationGateReportDto,
  type LiveQueueHealthDto,
  type RateCoverageReportDto,
  type ReconciliationSummaryDto,
} from '@aiking/shared';

import { RequirePermission, Roles } from '../../common/decorators';
import { VoiceShadowReconciliationService } from './voice-shadow-reconciliation.service';

/**
 * Platform-internal Voice Shadow Reconciliation endpoints.
 *
 * Strictly restricted to Super Admin / platform billing capability:
 * `@RequirePermission(Permission.BILLING_VIEW_CROSS_TENANT)`
 *
 * Wholesale carrier costs, gross profit margins, and shadow profitability
 * are platform internal and must never be exposed to tenant Manager or Staff roles.
 */
@ApiTags('platform-voice-shadow')
@Controller('platform/billing/voice-shadow')
@Roles(Role.SUPER_ADMIN)
@RequirePermission(Permission.BILLING_VIEW_CROSS_TENANT)
export class PlatformShadowReconciliationController {
  constructor(private readonly reconciliation: VoiceShadowReconciliationService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Platform-wide or filtered voice shadow reconciliation summary (Super Admin)' })
  async getSummary(
    @Query('tenantId') tenantId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<ReconciliationSummaryDto> {
    return this.reconciliation.getReconciliationSummary({
      tenantId: tenantId?.trim() || undefined,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
    });
  }

  @Get('rate-coverage')
  @ApiOperation({ summary: 'Evaluate RateCatalog wholesale coverage for voice destinations (Super Admin)' })
  async getRateCoverage(@Query('provider') provider?: string): Promise<RateCoverageReportDto> {
    return this.reconciliation.getRateCoverageReport({
      provider: provider?.trim() || undefined,
    });
  }

  @Get('activation-gate')
  @ApiOperation({ summary: 'Evaluate Voice Activation Gate criteria (Super Admin)' })
  async getActivationGate(
    @Query('minSampleCount') minSampleCount?: string,
    @Query('maxConflictsAllowed') maxConflictsAllowed?: string,
    @Query('maxUnknownProvidersAllowed') maxUnknownProvidersAllowed?: string,
    @Query('minResolvedRateCoveragePercent') minResolvedRateCoveragePercent?: string,
  ): Promise<ActivationGateReportDto> {
    return this.reconciliation.evaluateActivationGate({
      minSampleCount: minSampleCount ? Number(minSampleCount) : undefined,
      maxConflictsAllowed: maxConflictsAllowed ? Number(maxConflictsAllowed) : undefined,
      maxUnknownProvidersAllowed: maxUnknownProvidersAllowed
        ? Number(maxUnknownProvidersAllowed)
        : undefined,
      minResolvedRateCoveragePercent: minResolvedRateCoveragePercent
        ? Number(minResolvedRateCoveragePercent)
        : undefined,
    });
  }

  @Get('queue-health')
  @ApiOperation({ summary: 'Inspect live queue health for background workers (Super Admin)' })
  async getQueueHealth(): Promise<LiveQueueHealthDto> {
    return this.reconciliation.getLiveQueueHealth();
  }
}
