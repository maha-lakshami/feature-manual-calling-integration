import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { RateCatalogModule } from '../rate-catalog/rate-catalog.module';
import { BillingController } from './billing.controller';
import { MeteringService } from './metering.service';
import { PricingService } from './pricing.service';
import { RatingEngineService } from './rating-engine.service';
import { RatingSnapshotService } from './rating-snapshot.service';

/**
 * Metering and pricing — spec §8.2, §9.3.
 *
 * Both services are exported: campaigns charge per message, calls charge per billed
 * minute, and both need the same estimate before they start. `MeteringService` is the
 * only component that writes `usage_events`, which is what keeps the metered record
 * and the wallet movement in one transaction.
 */
@Module({
  imports: [WalletModule, RateCatalogModule],
  controllers: [BillingController],
  providers: [PricingService, MeteringService, RatingEngineService, RatingSnapshotService],
  exports: [PricingService, MeteringService, RatingEngineService, RatingSnapshotService],
})
export class BillingModule {}
