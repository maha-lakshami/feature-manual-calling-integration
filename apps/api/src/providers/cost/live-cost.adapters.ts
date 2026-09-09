import { Injectable, Logger } from '@nestjs/common';
import {
  Channel,
  CostSource,
  CostUnavailableReason,
  microPaiseToPaiseCeil,
  type ProviderCostResolution,
  type ProviderUsage,
} from '@aiking/shared';
import type { ProviderCostResolver } from './cost-resolver.interface';
import { RateCatalogService } from '../../modules/rate-catalog/rate-catalog.service';

/**
 * Plivo voice cost resolver adapter.
 *
 * Current Plivo outbound API responses and event callbacks do not include
 * authoritative wholesale billing amounts in real time. Plivo wholesale cost is
 * resolved via the authoritative effective-dated Rate Catalog.
 */
@Injectable()
export class PlivoCostAdapter implements ProviderCostResolver {
  readonly provider = 'plivo';
  readonly supportedChannels = [Channel.CALL] as const;

  private readonly logger = new Logger(PlivoCostAdapter.name);

  constructor(private readonly rateCatalog: RateCatalogService) {}

  async estimateCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
    return this.resolveFromCatalog(usage, new Date(), CostSource.RATE_CATALOG);
  }

  async resolveActualCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
    const occurredAt = (usage.metadata?.occurredAt as Date) ?? new Date();
    return this.resolveFromCatalog(usage, occurredAt, CostSource.RATE_CATALOG);
  }

  private async resolveFromCatalog(
    usage: ProviderUsage,
    occurredAt: Date,
    source: CostSource,
  ): Promise<ProviderCostResolution> {
    const rate = await this.rateCatalog.resolveRate({
      provider: this.provider,
      channel: Channel.CALL,
      destination: usage.destination,
      unit: usage.unit,
      currency: usage.currency,
      occurredAt,
    });

    if (!rate) {
      return {
        available: false,
        provider: this.provider,
        channel: usage.channel,
        reason: CostUnavailableReason.RATE_NOT_CONFIGURED,
        message: `No active wholesale rate configured for plivo on channel CALL`,
      };
    }

    const costMicroPaise = BigInt(usage.quantity) * rate.rateMicroPaise;
    const costPaise = microPaiseToPaiseCeil(costMicroPaise);

    return {
      available: true,
      cost: {
        provider: this.provider,
        channel: Channel.CALL,
        quantity: usage.quantity,
        unit: rate.unit,
        currency: rate.currency,
        costPaise,
        costMicroPaise,
        rateMicroPaise: rate.rateMicroPaise,
        providerRateId: rate.id,
        source,
        calculatedAt: new Date(),
        metadata: {
          rateId: rate.id,
          version: rate.version,
          destinationPattern: rate.destinationPattern,
        },
      },
    };
  }
}

/**
 * Meta WhatsApp Cloud API cost resolver adapter.
 *
 * Meta WhatsApp messages are billed via out-of-band monthly invoicing according
 * to template categories (marketing, utility, service, authentication).
 * Resolves wholesale cost from the authoritative Rate Catalog.
 */
@Injectable()
export class MetaWhatsAppCostAdapter implements ProviderCostResolver {
  readonly provider = 'meta';
  readonly supportedChannels = [Channel.WHATSAPP] as const;

  private readonly logger = new Logger(MetaWhatsAppCostAdapter.name);

  constructor(private readonly rateCatalog: RateCatalogService) {}

  async estimateCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
    const category = typeof usage.metadata?.category === 'string' ? usage.metadata.category : null;
    return this.resolveFromCatalog(usage, category, new Date(), CostSource.RATE_CATALOG);
  }

  async resolveActualCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
    const category = typeof usage.metadata?.category === 'string' ? usage.metadata.category : null;
    const occurredAt = (usage.metadata?.occurredAt as Date) ?? new Date();
    return this.resolveFromCatalog(usage, category, occurredAt, CostSource.RATE_CATALOG);
  }

  private async resolveFromCatalog(
    usage: ProviderUsage,
    category: string | null,
    occurredAt: Date,
    source: CostSource,
  ): Promise<ProviderCostResolution> {
    const rate = await this.rateCatalog.resolveRate({
      provider: this.provider,
      channel: Channel.WHATSAPP,
      destination: usage.destination,
      category,
      unit: usage.unit,
      currency: usage.currency,
      occurredAt,
    });

    if (!rate) {
      return {
        available: false,
        provider: this.provider,
        channel: usage.channel,
        reason: CostUnavailableReason.RATE_NOT_CONFIGURED,
        message: `No active wholesale rate configured for meta on channel WHATSAPP`,
      };
    }

    const costMicroPaise = BigInt(usage.quantity) * rate.rateMicroPaise;
    const costPaise = microPaiseToPaiseCeil(costMicroPaise);

    return {
      available: true,
      cost: {
        provider: this.provider,
        channel: Channel.WHATSAPP,
        quantity: usage.quantity,
        unit: rate.unit,
        currency: rate.currency,
        costPaise,
        costMicroPaise,
        rateMicroPaise: rate.rateMicroPaise,
        source,
        calculatedAt: new Date(),
        metadata: {
          rateId: rate.id,
          version: rate.version,
          destinationPattern: rate.destinationPattern,
          category: rate.category,
        },
      },
    };
  }
}

/**
 * Amazon SES / SMTP email cost resolver adapter.
 *
 * SMTP relays and SES SMTP endpoints deliver messages without returning
 * per-transaction wholesale costs. Resolves wholesale cost from the Rate Catalog.
 */
@Injectable()
export class SesEmailCostAdapter implements ProviderCostResolver {
  readonly provider = 'ses';
  readonly supportedChannels = [Channel.EMAIL] as const;

  private readonly logger = new Logger(SesEmailCostAdapter.name);

  constructor(private readonly rateCatalog: RateCatalogService) {}

  async estimateCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
    return this.resolveFromCatalog(usage, new Date(), CostSource.RATE_CATALOG);
  }

  async resolveActualCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
    const occurredAt = (usage.metadata?.occurredAt as Date) ?? new Date();
    return this.resolveFromCatalog(usage, occurredAt, CostSource.RATE_CATALOG);
  }

  private async resolveFromCatalog(
    usage: ProviderUsage,
    occurredAt: Date,
    source: CostSource,
  ): Promise<ProviderCostResolution> {
    const rate = await this.rateCatalog.resolveRate({
      provider: this.provider,
      channel: Channel.EMAIL,
      destination: usage.destination,
      unit: usage.unit,
      currency: usage.currency,
      occurredAt,
    });

    if (!rate) {
      return {
        available: false,
        provider: this.provider,
        channel: usage.channel,
        reason: CostUnavailableReason.RATE_NOT_CONFIGURED,
        message: `No active wholesale rate configured for ses on channel EMAIL`,
      };
    }

    const costMicroPaise = BigInt(usage.quantity) * rate.rateMicroPaise;
    const costPaise = microPaiseToPaiseCeil(costMicroPaise);

    return {
      available: true,
      cost: {
        provider: this.provider,
        channel: Channel.EMAIL,
        quantity: usage.quantity,
        unit: rate.unit,
        currency: rate.currency,
        costPaise,
        costMicroPaise,
        rateMicroPaise: rate.rateMicroPaise,
        source,
        calculatedAt: new Date(),
        metadata: {
          rateId: rate.id,
          version: rate.version,
        },
      },
    };
  }
}
