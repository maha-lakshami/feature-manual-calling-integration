import { Channel, CommunicationEventType, RecipientStatus } from '@aiking/shared';

import { TenantContext } from '../../common/tenant/tenant-context';
import { CampaignsService } from './campaigns.service';

describe('email callback tenant and suppression isolation', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';

  function serviceWith(prisma: any, communications = { recordSafely: jest.fn() }) {
    const tenantContext = new TenantContext();
    return {
      service: new CampaignsService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        communications as any,
        tenantContext,
      ),
      communications,
      tenantContext,
    };
  }

  it('fails a bounce with ambiguous cross-tenant provider-message ownership', async () => {
    const prisma = {
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'recipient-a', tenantId: tenantA },
          { id: 'recipient-b', tenantId: tenantB },
        ]),
        findFirst: jest.fn(),
      },
    };
    const { service } = serviceWith(prisma);

    await expect(
      service.applyDeliveryStatus({
        providerMessageId: 'ses-shared',
        channel: Channel.EMAIL,
        status: RecipientStatus.BOUNCED,
        occurredAt: new Date(),
      }),
    ).rejects.toThrow('ambiguous tenant ownership');
    expect(prisma.campaignRecipient.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the system scope active while a lazy Prisma callback lookup executes', async () => {
    const tenantContext = new TenantContext();
    let observedSystemScope = false;
    const lazyRows = {
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        try {
          observedSystemScope = tenantContext.unscoped?.kind === 'system';
          return Promise.resolve([
            { id: 'recipient-a', tenantId: tenantA },
            { id: 'recipient-b', tenantId: tenantB },
          ]).then(resolve, reject);
        } catch (error) {
          return reject(error);
        }
      },
    };
    const prisma = {
      campaignRecipient: {
        findMany: jest.fn().mockReturnValue(lazyRows),
        findFirst: jest.fn(),
      },
    };
    const service = new CampaignsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      tenantContext,
    );

    await expect(
      service.applyDeliveryStatus({
        providerMessageId: 'lazy-provider-message',
        channel: Channel.WHATSAPP,
        status: RecipientStatus.READ,
        occurredAt: new Date(),
      }),
    ).rejects.toThrow('ambiguous tenant ownership');
    expect(observedSystemScope).toBe(true);
  });

  it('rejects a complaint when the Contact relation does not belong to the resolved tenant', async () => {
    const prisma = {
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue([{ id: 'recipient-a', tenantId: tenantA, contactId: 'contact-b' }]),
      },
      contact: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
    };
    const { service, communications } = serviceWith(prisma);

    await expect(service.applyEmailComplaint('ses-1')).rejects.toThrow('contact ownership mismatch');
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 'contact-b', tenantId: tenantA, deletedAt: null },
      select: { id: true },
    });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
    expect(communications.recordSafely).not.toHaveBeenCalled();
  });

  it('suppresses once and records one tenant-scoped complaint event on replay', async () => {
    let optedIn = true;
    const prisma = {
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue([{ id: 'recipient-a', tenantId: tenantA, contactId: 'contact-a' }]),
      },
      contact: {
        findFirst: jest.fn().mockResolvedValue({ id: 'contact-a' }),
        updateMany: jest.fn().mockImplementation(async () => {
          if (!optedIn) return { count: 0 };
          optedIn = false;
          return { count: 1 };
        }),
      },
    };
    const communications = { recordSafely: jest.fn().mockResolvedValue(undefined) };
    const { service } = serviceWith(prisma, communications);

    await service.applyEmailComplaint('ses-1');
    await service.applyEmailComplaint('ses-1');

    expect(prisma.campaignRecipient.findMany).toHaveBeenCalledWith({
      where: { providerMessageId: 'ses-1', campaign: { channel: Channel.EMAIL } },
      select: { id: true, tenantId: true, contactId: true },
      take: 2,
    });
    expect(communications.recordSafely).toHaveBeenCalledTimes(1);
    expect(communications.recordSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: tenantA,
        contactId: 'contact-a',
        eventType: CommunicationEventType.CONTACT_OPTED_OUT,
      }),
    );
  });
});
