import { CampaignStatus, Channel } from '@aiking/shared';

import { CampaignsService } from './campaigns.service';

const campaignId = '11111111-1111-1111-1111-111111111111';

const campaign = (overrides: Record<string, unknown> = {}) => ({
  id: campaignId,
  name: 'Draft reminder',
  channel: Channel.EMAIL,
  status: CampaignStatus.DRAFT,
  startedAt: null,
  completedAt: null,
  estimatedCostPaise: 0n,
  actualCostPaise: 0n,
  ...overrides,
});

const buildService = (row = campaign(), historyCount = 0) => {
  const remove = jest.fn().mockResolvedValue(row);
  const prisma = {
    campaign: { findUnique: jest.fn().mockResolvedValue(row), delete: remove },
    campaignRecipient: { count: jest.fn().mockResolvedValue(historyCount) },
    usageEvent: { count: jest.fn().mockResolvedValue(historyCount) },
    communicationEvent: { count: jest.fn().mockResolvedValue(historyCount) },
  };
  return {
    remove,
    service: new CampaignsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ),
  };
};

describe('CampaignsService safe deletion lifecycle', () => {
  it('deletes an untouched draft with no recipient, provider, or financial history', async () => {
    const { service, remove } = buildService();

    await service.remove(campaignId);

    expect(remove).toHaveBeenCalledWith({ where: { id: campaignId } });
  });

  it.each([
    CampaignStatus.QUEUED,
    CampaignStatus.SENDING,
    CampaignStatus.COMPLETED,
    CampaignStatus.COMPLETED_WITH_FAILURES,
    CampaignStatus.CANCELLED,
    CampaignStatus.FAILED,
  ])('never hard-deletes a %s campaign', async (status) => {
    const { service, remove } = buildService(campaign({ status }));

    await expect(service.remove(campaignId)).rejects.toMatchObject({ status: 409 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('preserves even a draft when related history exists', async () => {
    const { service, remove } = buildService(campaign(), 1);

    await expect(service.remove(campaignId)).rejects.toMatchObject({ status: 409 });
    expect(remove).not.toHaveBeenCalled();
  });
});
