import { Inject, Injectable, Logger } from '@nestjs/common';
import { Channel, type ProviderRateDto } from '@aiking/shared';
import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';

export class ConflictingRateException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictingRateException';
  }
}

export interface ResolveRateInput {
  readonly provider: string;
  readonly channel: Channel;
  readonly destination?: string | null;
  readonly category?: string | null;
  readonly unit: string;
  readonly currency?: string;
  readonly occurredAt?: Date;
}

export interface UpsertRateInput {
  readonly provider: string;
  readonly channel: Channel;
  readonly destinationPattern?: string;
  readonly category?: string | null;
  readonly unit: string;
  readonly rateMicroPaise: bigint;
  readonly currency?: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date | null;
  readonly description?: string | null;
  readonly createdBy?: string | null;
}

export interface ProviderRateEntity {
  id: string;
  provider: string;
  channel: Channel;
  destinationPattern: string;
  category: string | null;
  unit: string;
  rateMicroPaise: bigint;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  active: boolean;
  version: number;
  description: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Service managing authoritative wholesale provider rate cards.
 *
 * Rules:
 * - PLATFORM data: Not tenant-scoped. Wholesale rates are internal to AiConnect.
 * - End-to-end BigInt micro-paise precision (1 paisa = 1,000,000 micro-paise).
 * - Canonical currency: INR in v1. Other currencies fail closed.
 * - Transactional concurrency safety: Serialized via PostgreSQL transaction-scoped advisory lock.
 * - No overlapping active ranges for the same dimension tuple.
 * - Active flag is an administrative kill switch; historical validity is governed by effectiveFrom/effectiveTo.
 * - Deterministic specificity matching: exact category -> longest matching destination prefix -> wildcard (*).
 * - Authoritative DB lookups (no in-memory cache in Phase 3).
 */
@Injectable()
export class RateCatalogService {
  private readonly logger = new Logger(RateCatalogService.name);

  constructor(@Inject(PRISMA) private readonly prisma: ExtendedPrismaClient) {}

  /**
   * Resolve the authoritative wholesale rate for a usage event.
   *
   * Specificity precedence:
   *   1. Exact category match beats generic/null category
   *   2. Longest matching destination prefix beats shorter prefixes; '*' is wildcard (score 0)
   *   3. Most recent effectiveFrom
   *
   * Rejects non-INR currencies as unsupported in v1.
   */
  async resolveRate(input: ResolveRateInput): Promise<ProviderRateEntity | null> {
    const currency = (input.currency ?? 'INR').toUpperCase();
    if (currency !== 'INR') {
      this.logger.warn(`Rate resolution requested for unsupported currency "${currency}" — v1 supports INR only`);
      return null;
    }

    const provider = input.provider.toLowerCase();
    const channel = input.channel;
    const unit = input.unit.toLowerCase();
    const occurredAt = input.occurredAt ?? new Date();
    const destination = input.destination?.trim() || null;
    const category = input.category?.trim() || null;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        provider: string;
        channel: Channel;
        destination_pattern: string;
        category: string | null;
        unit: string;
        rate_micro_paise: bigint;
        currency: string;
        effective_from: Date;
        effective_to: Date | null;
        active: boolean;
        version: number;
        description: string | null;
        created_by: string | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      SELECT *
      FROM "provider_rates"
      WHERE "provider" = ${provider}
        AND "channel" = ${channel}::"Channel"
        AND "unit" = ${unit}
        AND "currency" = ${currency}
        AND "active" = true
        AND "effective_from" <= ${occurredAt}
        AND ("effective_to" IS NULL OR "effective_to" > ${occurredAt})
        AND (
          (${category}::text IS NOT NULL AND ("category" = ${category} OR "category" IS NULL))
          OR (${category}::text IS NULL AND "category" IS NULL)
        )
        AND (
          (${destination}::text IS NOT NULL AND ${destination} LIKE ("destination_pattern" || '%'))
          OR "destination_pattern" = '*'
        )
      ORDER BY
        (CASE WHEN ${category}::text IS NOT NULL AND "category" = ${category} THEN 2 WHEN "category" IS NULL THEN 1 ELSE 0 END) DESC,
        (CASE WHEN "destination_pattern" = '*' THEN 0 ELSE LENGTH("destination_pattern") END) DESC,
        "effective_from" DESC
      LIMIT 1;
    `;

    const match = rows[0];
    if (!match) return null;

    return this.mapFromDb(match);
  }

  /**
   * Concurrency-safe, transactional rate insertion / version update.
   *
   * Uses PostgreSQL transaction-scoped advisory locks on the exact rate dimension tuple:
   *   (provider, channel, destinationPattern, category, unit, currency)
   *
   * Guarantees:
   * - Two concurrent writers serialize and cannot create overlapping effective ranges.
   * - Existing active open-ended range has its effectiveTo set to newEffectiveFrom.
   * - Old rate remains active=true to preserve historical validity.
   * - Retroactive or overlapping ranges throw ConflictingRateException.
   */
  async upsertRate(input: UpsertRateInput): Promise<ProviderRateEntity> {
    const currency = (input.currency ?? 'INR').toUpperCase();
    if (currency !== 'INR') {
      throw new Error(`AiConnect Phase 3 Rate Catalog canonically supports INR pricing only, received: ${currency}`);
    }

    if (input.rateMicroPaise < 0n) {
      throw new Error(`rateMicroPaise cannot be negative, received: ${input.rateMicroPaise}`);
    }

    const provider = input.provider.toLowerCase().trim();
    const channel = input.channel;
    const destinationPattern = (input.destinationPattern?.trim() || '*');
    const category = input.category?.trim() || null;
    const unit = input.unit.toLowerCase().trim();
    const effectiveFrom = input.effectiveFrom;
    const effectiveTo = input.effectiveTo ?? null;

    if (effectiveTo && effectiveTo <= effectiveFrom) {
      throw new ConflictingRateException(
        `effectiveTo (${effectiveTo.toISOString()}) must be after effectiveFrom (${effectiveFrom.toISOString()})`,
      );
    }

    const lockKey = `${provider}:${channel}:${destinationPattern}:${category ?? '*'}:${unit}:${currency}`;

    return this.prisma.$transaction(async (tx) => {
      // Acquire PostgreSQL transaction-scoped advisory lock on the exact dimension tuple
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rate_catalog'), hashtext(${lockKey}))`;

      // Find any existing active rates that overlap with the new effectiveFrom
      const overlapping = await tx.providerRate.findMany({
        where: {
          provider,
          channel,
          destinationPattern,
          category,
          unit,
          currency,
          active: true,
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gt: effectiveFrom } },
          ],
        },
        orderBy: { effectiveFrom: 'desc' },
      });

      // Check for retroactive conflict: if an existing rate starts at or after the new rate
      const futureConflict = overlapping.find((r) => r.effectiveFrom >= effectiveFrom);
      if (futureConflict) {
        throw new ConflictingRateException(
          `Cannot insert rate effective from ${effectiveFrom.toISOString()}: existing version ${futureConflict.version} already starts at ${futureConflict.effectiveFrom.toISOString()}`,
        );
      }

      // Close the previous active rate: set effectiveTo = effectiveFrom.
      // Retain active = true so historical queries at past timestamps still resolve it.
      for (const previous of overlapping) {
        if (previous.effectiveTo === null || previous.effectiveTo > effectiveFrom) {
          await tx.providerRate.update({
            where: { id: previous.id },
            data: { effectiveTo: effectiveFrom },
          });
          this.logger.log(
            `Closed previous rate ${previous.id} (version ${previous.version}) with effectiveTo=${effectiveFrom.toISOString()}`,
          );
        }
      }

      // Compute next version
      const latestVersion = await tx.providerRate.findFirst({
        where: {
          provider,
          channel,
          destinationPattern,
          category,
          unit,
          currency,
        },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const nextVersion = (latestVersion?.version ?? 0) + 1;

      const created = await tx.providerRate.create({
        data: {
          provider,
          channel,
          destinationPattern,
          category,
          unit,
          rateMicroPaise: input.rateMicroPaise,
          currency,
          effectiveFrom,
          effectiveTo,
          active: true,
          version: nextVersion,
          description: input.description ?? null,
          createdBy: input.createdBy ?? null,
        },
      });

      this.logger.log(
        `Created rate ${created.id} (version ${created.version}) for ${provider}:${channel} (${destinationPattern}) @ ${input.rateMicroPaise} micro-paise`,
      );

      return created;
    });
  }

  /**
   * Administrative enable/disable toggle.
   */
  async setActive(rateId: string, active: boolean): Promise<ProviderRateEntity> {
    const updated = await this.prisma.providerRate.update({
      where: { id: rateId },
      data: { active },
    });
    return updated;
  }

  toDto(entity: ProviderRateEntity): ProviderRateDto {
    return {
      id: entity.id,
      provider: entity.provider,
      channel: entity.channel,
      destinationPattern: entity.destinationPattern,
      category: entity.category,
      unit: entity.unit,
      rateMicroPaise: entity.rateMicroPaise.toString(),
      currency: entity.currency,
      effectiveFrom: entity.effectiveFrom.toISOString(),
      effectiveTo: entity.effectiveTo ? entity.effectiveTo.toISOString() : null,
      active: entity.active,
      version: entity.version,
      description: entity.description,
      createdBy: entity.createdBy,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  private mapFromDb(row: {
    id: string;
    provider: string;
    channel: Channel;
    destination_pattern: string;
    category: string | null;
    unit: string;
    rate_micro_paise: bigint;
    currency: string;
    effective_from: Date;
    effective_to: Date | null;
    active: boolean;
    version: number;
    description: string | null;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
  }): ProviderRateEntity {
    return {
      id: row.id,
      provider: row.provider,
      channel: row.channel,
      destinationPattern: row.destination_pattern,
      category: row.category,
      unit: row.unit,
      rateMicroPaise: BigInt(row.rate_micro_paise),
      currency: row.currency,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      active: row.active,
      version: row.version,
      description: row.description,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
