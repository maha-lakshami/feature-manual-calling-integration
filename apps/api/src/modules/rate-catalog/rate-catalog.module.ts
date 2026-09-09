import { Module } from '@nestjs/common';
import { RateCatalogService } from './rate-catalog.service';

/**
 * Dedicated RateCatalogModule.
 *
 * Exposes wholesale provider rate catalog lookup and transactional management.
 * Isolated from BillingModule and ProvidersModule to guarantee zero circular dependencies.
 */
@Module({
  providers: [RateCatalogService],
  exports: [RateCatalogService],
})
export class RateCatalogModule {}
