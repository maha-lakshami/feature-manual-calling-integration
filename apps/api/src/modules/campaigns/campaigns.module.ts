import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { CommunicationsModule } from '../communications/communications.module';
import { QueueModule } from '../queue/queue.module';
import { RateCatalogModule } from '../rate-catalog/rate-catalog.module';
import { TemplatesModule } from '../templates/templates.module';
import { WalletModule } from '../wallet/wallet.module';
import { CampaignProcessors } from './campaign.processors';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { EmailShadowRatingService } from './email-shadow-rating.service';
import { WhatsAppShadowRatingService } from './whatsapp-shadow-rating.service';

/**
 * Campaigns — spec §6.1, §6.2.
 *
 * The processors are registered in the same module as the service on purpose: they are
 * two entrypoints (HTTP and queue) to one domain, and §3.5's modular monolith means the
 * worker boots the same `AppModule`. `QueueService.register` in `onModuleInit` decides
 * which of them actually runs, based on `APP_ROLE`.
 */
@Module({
  imports: [QueueModule, TemplatesModule, BillingModule, WalletModule, CommunicationsModule, RateCatalogModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignProcessors, WhatsAppShadowRatingService, EmailShadowRatingService],
  exports: [CampaignsService, WhatsAppShadowRatingService, EmailShadowRatingService],
})
export class CampaignsModule {}
