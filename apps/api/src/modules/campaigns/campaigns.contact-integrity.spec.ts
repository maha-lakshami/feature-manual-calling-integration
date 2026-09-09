import { Channel } from '@aiking/shared';

import { CampaignsService } from './campaigns.service';

describe('CampaignsService archived contacts', () => {
  it('excludes deleted contacts from campaign audience selection', async () => {
    const prisma = { contact: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new CampaignsService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await (service as any).resolveAudience(Channel.EMAIL, { filter: { all: true } });
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  });
});
