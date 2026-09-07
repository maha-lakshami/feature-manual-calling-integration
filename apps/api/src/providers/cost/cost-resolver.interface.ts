import type { Channel, ProviderCostResolution, ProviderUsage } from '@aiking/shared';

/**
 * Provider-neutral interface for resolving wholesale service costs.
 *
 * Each communication channel / vendor (Plivo, Twilio, Meta WhatsApp, AWS SES, etc.)
 * implements this interface via an adapter. The rest of the platform talks
 * exclusively to this abstraction, keeping vendor-specific pricing details
 * strictly below the domain rating layer.
 */
export interface ProviderCostResolver {
  /** Identifier of the provider (e.g. 'plivo', 'twilio', 'meta', 'ses'). */
  readonly provider: string;

  /** Channels supported by this adapter. */
  readonly supportedChannels: readonly Channel[];

  /**
   * Upfront estimate of provider cost for the given usage before execution.
   */
  estimateCost(usage: ProviderUsage): Promise<ProviderCostResolution>;

  /**
   * Reconcile authoritative wholesale cost after execution or upon callback/CDR.
   */
  resolveActualCost(usage: ProviderUsage): Promise<ProviderCostResolution>;
}

export const PROVIDER_COST_RESOLVER = 'PROVIDER_COST_RESOLVER';
