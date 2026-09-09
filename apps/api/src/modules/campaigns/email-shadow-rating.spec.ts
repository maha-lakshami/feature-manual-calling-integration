import { Channel, CostSource } from '@aiking/shared';

import { RatingEngineService } from '../billing/rating-engine.service';
import { EmailLiveProvider } from '../../providers/email/email.live';
import { EmailShadowRatingService } from './email-shadow-rating.service';

const tenantId = '10000000-0000-0000-0000-000000000001';
const campaignId = '20000000-0000-0000-0000-000000000001';
const recipientId = '30000000-0000-0000-0000-000000000001';
const sentAt = new Date('2026-08-15T10:00:00.000Z');

function fixture(overrides: Record<string, unknown> = {}) {
  const recipient = {
    id: recipientId,
    tenantId,
    campaignId,
    destination: 'customer@example.com',
    provider: 'ses',
    providerMessageId: 'ses-message-1',
    sentAt,
    costPaise: 12n,
    campaign: { id: campaignId, channel: Channel.EMAIL },
    ...overrides,
  };
  const ratings: any[] = [];
  const conflicts: any[] = [];
  const reconciliations: any[] = [];

  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockImplementation(() =>
      ratings.length
        ? [
            [...ratings]
              .sort((a, b) => b.ratingVersion - a.ratingVersion)
              .find((row) => row.campaignRecipientId === recipientId),
          ].filter(Boolean)
        : [],
    ),
    campaignRecipient: {
      findUnique: jest.fn().mockResolvedValue(recipient),
      count: jest.fn().mockResolvedValue(1),
    },
    campaign: {
      findUnique: jest.fn().mockResolvedValue({ tenantId, channel: Channel.EMAIL }),
    },
    emailShadowRating: {
      findFirst: jest.fn().mockImplementation(() =>
        [...ratings].sort((a, b) => b.ratingVersion - a.ratingVersion)[0] ?? null,
      ),
      create: jest.fn().mockImplementation(({ data }) => {
        const row = {
          id: `rating-${ratings.length + 1}`,
          createdAt: new Date('2026-09-07T00:00:00.000Z'),
          ...data,
        };
        ratings.push(row);
        return row;
      }),
    },
    emailShadowRatingConflict: {
      create: jest.fn().mockImplementation(({ data }) => {
        conflicts.push(data);
        return data;
      }),
    },
    emailCampaignShadowReconciliation: {
      findFirst: jest.fn().mockImplementation(() => reconciliations.at(-1) ?? null),
      create: jest.fn().mockImplementation(({ data }) => {
        const row = {
          id: `reconciliation-${reconciliations.length + 1}`,
          createdAt: new Date('2026-09-07T00:00:00.000Z'),
          ...data,
        };
        reconciliations.push(row);
        return row;
      }),
    },
  };
  const prisma: any = { ...tx, $transaction: jest.fn((callback) => callback(tx)) };
  const rateCatalog: any = { resolveRate: jest.fn() };
  const tenantContext: any = { requireTenantId: jest.fn().mockReturnValue(tenantId) };
  const service = new EmailShadowRatingService(
    prisma,
    rateCatalog,
    new RatingEngineService(),
    tenantContext,
  );
  return { service, rateCatalog, tx, ratings, conflicts, reconciliations, recipient };
}

describe('EmailShadowRatingService (Phase 6)', () => {
  it('derives live provider identity from trusted configured transport', () => {
    expect(new EmailLiveProvider({ email: { transport: 'ses' } } as any).providerId).toBe('ses');
    expect(new EmailLiveProvider({ email: { transport: 'smtp' } } as any).providerId).toBe('smtp');
  });

  it('uses persisted sentAt and exact email dimensions to resolve a rate', async () => {
    const f = fixture();
    f.rateCatalog.resolveRate.mockResolvedValue({ id: 'rate-1', rateMicroPaise: 840_000n, version: 3 });

    const result = await f.service.rateRecipient(recipientId);

    expect(result.recorded).toBe(true);
    expect(f.rateCatalog.resolveRate).toHaveBeenCalledWith({
      provider: 'ses',
      channel: Channel.EMAIL,
      destination: '*',
      category: null,
      unit: 'email',
      currency: 'INR',
      occurredAt: sentAt,
    });
    expect(f.ratings[0]).toMatchObject({
      ratingVersion: 1,
      status: 'RATED',
      quantity: 1,
      rateMicroPaise: 840_000n,
      providerCostMicroPaise: 840_000n,
      costSource: CostSource.RATE_CATALOG,
      legacyCustomerChargePaise: 12n,
      occurredAt: sentAt,
    });
  });

  it('recovers RATE_NOT_CONFIGURED as v2 without recording a conflict', async () => {
    const f = fixture();
    f.rateCatalog.resolveRate.mockResolvedValueOnce(null);
    const first = await f.service.rateRecipient(recipientId);
    expect(first.recorded && first.shadowRating.status).toBe('COST_UNAVAILABLE');
    expect(f.ratings[0].unavailableReason).toBe('RATE_NOT_CONFIGURED');

    f.rateCatalog.resolveRate.mockResolvedValueOnce({ id: 'new-rate', rateMicroPaise: 125_001n, version: 1 });
    const recovered = await f.service.rateRecipient(recipientId);

    expect(recovered.recorded && recovered.shadowRating.status).toBe('RATED');
    expect(f.ratings).toHaveLength(2);
    expect(f.ratings[1]).toMatchObject({ ratingVersion: 2, providerRateId: 'new-rate' });
    expect(f.conflicts).toHaveLength(0);
    expect(f.rateCatalog.resolveRate).toHaveBeenLastCalledWith(expect.objectContaining({ occurredAt: sentAt }));
  });

  it('does not infer a historical provider', async () => {
    const f = fixture({ provider: null });
    const result = await f.service.rateRecipient(recipientId);

    expect(result.recorded && result.shadowRating.status).toBe('PROVIDER_UNKNOWN');
    expect(f.rateCatalog.resolveRate).not.toHaveBeenCalled();
  });

  it.each([
    ['sentAt', null, 'SENT_AT_MISSING'],
    ['providerMessageId', null, 'PROVIDER_MESSAGE_ID_MISSING'],
    ['costPaise', null, 'LEGACY_CHARGE_MISSING'],
  ])('records partial %s evidence as INVALID_STATE', async (field, value, reason) => {
    const f = fixture({ [field]: value });
    const result = await f.service.rateRecipient(recipientId);
    expect(result.recorded && result.shadowRating.status).toBe('INVALID_STATE');
    expect(f.ratings[0].unavailableReason).toBe(reason);
  });

  it('audits contradictory immutable evidence and preserves the original rating', async () => {
    const f = fixture();
    f.rateCatalog.resolveRate.mockResolvedValue({ id: 'rate-1', rateMicroPaise: 1n, version: 1 });
    await f.service.rateRecipient(recipientId);
    f.recipient.costPaise = 99n;

    const conflict = await f.service.rateRecipient(recipientId);

    expect(conflict).toMatchObject({ recorded: false, conflict: true, reason: 'RECONCILIATION_CONFLICT' });
    expect(f.ratings).toHaveLength(1);
    expect(f.conflicts).toHaveLength(1);
  });

  it('aggregates micro-paise first and rounds once through RatingEngineService', async () => {
    const f = fixture();
    f.ratings.push(
      {
        campaignRecipientId: recipientId,
        ratingVersion: 1,
        status: 'RATED',
        providerCostMicroPaise: 400_001n,
        legacyCustomerChargePaise: 1n,
      },
      {
        campaignRecipientId: 'recipient-2',
        ratingVersion: 1,
        status: 'RATED',
        providerCostMicroPaise: 400_001n,
        legacyCustomerChargePaise: 1n,
      },
    );
    f.tx.$queryRaw.mockResolvedValue(f.ratings);
    f.tx.campaignRecipient.count.mockResolvedValueOnce(2).mockResolvedValueOnce(2);

    const reconciliation = await f.service.reconcileCampaign(campaignId);

    expect(reconciliation.totalProviderCostMicroPaise).toBe('800002');
    expect(reconciliation.ratedShadowTotalPaise).toBe('2');
    expect(reconciliation.ratedLegacyTotalPaise).toBe('2');
    expect(reconciliation.isFinal).toBe(true);
  });

  it('keeps values beyond Number.MAX_SAFE_INTEGER exact', async () => {
    const f = fixture();
    const huge = 10_000_000_000_000_000_000n;
    f.tx.$queryRaw.mockResolvedValue([
      {
        campaignRecipientId: recipientId,
        status: 'RATED',
        providerCostMicroPaise: huge,
        legacyCustomerChargePaise: 1_000_000_000_000n,
      },
    ]);
    const result = await f.service.reconcileCampaign(campaignId);
    expect(result.totalProviderCostMicroPaise).toBe(huge.toString());
    expect(result.retailAmountMicroPaise).toBe('12500000000000000000');
  });

  it('fails closed across tenant ownership boundaries', async () => {
    const f = fixture({ tenantId: 'other-tenant' });
    const result = await f.service.rateRecipient(recipientId);
    expect(result).toMatchObject({ recorded: false, reason: 'RECIPIENT_NOT_FOUND' });
    expect(f.ratings).toHaveLength(0);
  });
});
