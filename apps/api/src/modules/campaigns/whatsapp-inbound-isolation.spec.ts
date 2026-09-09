import { CommunicationEventType } from '@aiking/shared';

import { TenantContext } from '../../common/tenant/tenant-context';
import { CampaignsService } from './campaigns.service';

describe('Inbound WhatsApp tenant isolation', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';
  const sender = '+919876543210';

  function fixture(ownership: Record<string, string[]> = { 'receiver-a': [tenantA], 'receiver-b': [tenantB] }) {
    const contacts = [
      { id: 'contact-a', tenantId: tenantA, phone: sender, deletedAt: null },
      { id: 'contact-b', tenantId: tenantB, phone: sender, deletedAt: null },
    ];
    const saved: Array<{ tenantId: string; contactId: string; providerReference?: string | null }> = [];
    const tenantContext = new TenantContext();
    const prisma = {
      tenant: {
        findMany: jest.fn().mockImplementation(async ({ where }: any) =>
          (ownership[where.whatsappPhoneNumberId] ?? []).map((id) => ({ id })),
        ),
      },
      contact: {
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          contacts.find(
            (contact) =>
              contact.tenantId === where.tenantId &&
              contact.phone === where.phone &&
              contact.deletedAt === where.deletedAt,
          ) ?? null,
        ),
      },
      communicationEvent: {
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          saved.find(
            (event) =>
              event.tenantId === where.tenantId &&
              event.contactId === where.contactId &&
              event.providerReference === where.providerReference,
          ) ?? null,
        ),
      },
    };
    const communications = {
      record: jest.fn().mockImplementation(async (input: any) => {
        expect(tenantContext.requireTenantId('test inbound write')).toBe(input.tenantId);
        saved.push(input);
        return input;
      }),
    };
    const service = new CampaignsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      communications as any,
      tenantContext,
    );
    const deliver = (phoneNumberId: string, providerMessageId = 'wamid-1') =>
      service.applyInboundMessage({
        providerMessageId,
        phoneNumberId,
        from: '9876543210',
        text: 'Where is my shipment?',
        occurredAt: new Date('2026-01-01T00:00:00Z'),
      });
    return { service, prisma, communications, saved, deliver };
  }

  it('routes a shared sender phone only to Tenant A when receiver A is addressed', async () => {
    const { prisma, saved, deliver } = fixture();
    await deliver('receiver-a');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ tenantId: tenantA, contactId: 'contact-a', providerReference: 'wamid-1' });
    expect(saved.some((event) => event.tenantId === tenantB)).toBe(false);
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { tenantId: tenantA, phone: sender, deletedAt: null },
      select: { id: true },
    });
  });

  it('routes the same sender only to Tenant B when receiver B is addressed', async () => {
    const { saved, deliver } = fixture();
    await deliver('receiver-b', 'wamid-2');
    expect(saved).toEqual([
      expect.objectContaining({ tenantId: tenantB, contactId: 'contact-b', providerReference: 'wamid-2' }),
    ]);
  });

  it('never loads Tenant B Contact while processing Tenant A inbound traffic', async () => {
    const { prisma, deliver } = fixture();
    await deliver('receiver-a');
    expect(prisma.contact.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: tenantB }) }),
    );
  });

  it('fails an unknown receiving phone number without loading a Contact', async () => {
    const { prisma, communications, deliver } = fixture();
    await expect(deliver('unknown-receiver')).rejects.toThrow('not assigned to a tenant');
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(communications.record).not.toHaveBeenCalled();
  });

  it('fails ambiguous receiving-number ownership without loading a Contact', async () => {
    const { prisma, communications, deliver } = fixture({ shared: [tenantA, tenantB] });
    await expect(deliver('shared')).rejects.toThrow('ambiguous tenant ownership');
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(communications.record).not.toHaveBeenCalled();
  });

  it('never lets sender phone alone select a tenant', async () => {
    const { prisma, deliver } = fixture();
    await expect(deliver('')).rejects.toThrow('no receiving phone number id');
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  it('normalizes the sender and performs an explicitly tenant-scoped Contact lookup', async () => {
    const { prisma, deliver } = fixture();
    await deliver('receiver-a');
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { tenantId: tenantA, phone: '+919876543210', deletedAt: null },
      select: { id: true },
    });
  });

  it('does not duplicate an inbound timeline event on persistence retry', async () => {
    const { communications, saved, deliver } = fixture();
    await deliver('receiver-a');
    await deliver('receiver-a');
    expect(saved).toHaveLength(1);
    expect(communications.record).toHaveBeenCalledTimes(1);
  });

  it('persists the inbound event type only inside the resolved tenant context', async () => {
    const { communications, deliver } = fixture();
    await deliver('receiver-a');
    expect(communications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: tenantA,
        contactId: 'contact-a',
        eventType: CommunicationEventType.WHATSAPP_INBOUND,
      }),
    );
  });
});
