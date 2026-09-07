import { CommunicationsService } from './communications.service';

describe('CommunicationsService archived contact history', () => {
  it('keeps an archived contact timeline queryable', async () => {
    const contact = {
      id: 'contact-1',
      fullName: 'Archived Alice',
      phone: '+919876543210',
      email: null,
      customFields: {},
      whatsappOptedIn: false,
      emailOptedIn: false,
      optedOutAt: null,
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    };
    const contacts = {
      getIncludingDeleted: jest.fn().mockResolvedValue(contact),
      get: jest.fn(),
    };
    const prisma = {
      communicationEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new CommunicationsService(prisma as any, contacts as any, {} as any);

    const result = await service.timeline(contact.id);

    expect(result.contact).toBe(contact);
    expect(contacts.getIncludingDeleted).toHaveBeenCalledWith(contact.id);
    expect(contacts.get).not.toHaveBeenCalled();
    expect(prisma.communicationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: contact.id } }),
    );
  });
});
