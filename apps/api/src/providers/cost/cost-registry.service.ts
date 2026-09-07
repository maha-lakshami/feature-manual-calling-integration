import { Injectable, Logger } from '@nestjs/common';
import {
  Channel,
  CostUnavailableReason,
  type ProviderCostResolution,
  type ProviderUsage,
} from '@aiking/shared';
import type { ProviderCostResolver } from './cost-resolver.interface';
import { MetaWhatsAppCostAdapter, PlivoCostAdapter, SesEmailCostAdapter } from './live-cost.adapters';

/**
 * Registry and dispatch point for provider cost resolution.
 *
 * Provides a single entry point for AiConnect billing to query estimated or
 * actual wholesale costs across all communication providers (Voice, WhatsApp, Email).
 * Adapters register themselves here; routing depends on the provider and channel,
 * ensuring no billing logic is ever coupled to a specific vendor.
 */
@Injectable()
export class CostRegistryService {
  private readonly logger = new Logger(CostRegistryService.name);
  private readonly resolvers = new Map<string, ProviderCostResolver>();

  constructor(
    plivo: PlivoCostAdapter,
    meta: MetaWhatsAppCostAdapter,
    ses: SesEmailCostAdapter,
  ) {
    this.register(plivo);
    this.register(meta);
    this.register(ses);
  }

  /**
   * Register a provider cost resolver.
   */
  register(resolver: ProviderCostResolver): void {
    const key = resolver.provider.toLowerCase();
    this.resolvers.set(key, resolver);
    this.logger.log(
      `Registered cost resolver for provider "${resolver.provider}" (channels: ${resolver.supportedChannels.join(', ')})`,
    );
  }

  /**
   * Look up a resolver by provider name and optional channel.
   */
  getResolver(provider: string, channel?: Channel): ProviderCostResolver | undefined {
    const resolver = this.resolvers.get(provider.toLowerCase());
    if (!resolver) return undefined;
    if (channel && !resolver.supportedChannels.includes(channel)) {
      return undefined;
    }
    return resolver;
  }

  /**
   * Estimate wholesale cost for a planned usage event.
   */
  async estimateCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
    this.validateUsage(usage);

    const resolver = this.getResolver(usage.provider, usage.channel);
    if (!resolver) {
      return {
        available: false,
        provider: usage.provider,
        channel: usage.channel,
        reason: CostUnavailableReason.NOT_SUPPORTED_BY_PROVIDER,
        message: `No cost resolver registered for provider "${usage.provider}" on channel "${usage.channel}"`,
      };
    }

    return resolver.estimateCost(usage);
  }

  /**
   * Resolve authoritative wholesale cost for an executed usage event.
   */
  async resolveActualCost(usage: ProviderUsage): Promise<ProviderCostResolution> {
    this.validateUsage(usage);

    const resolver = this.getResolver(usage.provider, usage.channel);
    if (!resolver) {
      return {
        available: false,
        provider: usage.provider,
        channel: usage.channel,
        reason: CostUnavailableReason.NOT_SUPPORTED_BY_PROVIDER,
        message: `No cost resolver registered for provider "${usage.provider}" on channel "${usage.channel}"`,
      };
    }

    return resolver.resolveActualCost(usage);
  }

  /**
   * Validate trusted usage parameters before resolving cost.
   * Ensures tenant context is explicitly provided and quantity is valid.
   */
  private validateUsage(usage: ProviderUsage): void {
    if (!usage.tenantId || typeof usage.tenantId !== 'string' || !usage.tenantId.trim()) {
      throw new Error('ProviderUsage requires a valid, trusted internal tenantId');
    }
    if (usage.quantity <= 0 || !Number.isFinite(usage.quantity)) {
      throw new Error(`ProviderUsage quantity must be positive, received: ${usage.quantity}`);
    }
    if (!usage.provider || typeof usage.provider !== 'string' || !usage.provider.trim()) {
      throw new Error('ProviderUsage requires a non-empty provider identifier');
    }
  }
}
