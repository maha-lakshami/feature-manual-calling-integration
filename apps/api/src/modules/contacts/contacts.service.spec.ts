import { createTenantIsolationExtension } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { ContactsService } from './contacts.service';

describe('ContactsService historical integrity', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const activeContact = {
    id: 'contact-1',
    tenantId,
    fullName: 'Alice',
    phone: '+919876543210',
    email: 'alice@example.com',
    customFields: {},
    tags: ['customer'],
    whatsappOptedIn: true,
    emailOptedIn: true,
    optedOutAt: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  function prismaMock(overrides: Record<string, unknown> = {}) {
    return {
      contact: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
        ...overrides,
      },
    };
  }

  function serviceWith(prisma: any) {
    const tenantContext = new TenantContext();
    const service = new ContactsService(prisma, tenantContext);
    const run = <T>(callback: () => T) =>
      tenantContext.runWithTenant(
        {
          tenantId,
          userId: 'user-1',
          role: 'manager' as any,
          isSuperAdmin: false,
          viaSupport: false,
          viaWorker: false,
        },
        callback,
      );
    return { service, run };
  }

  it('soft-deletes a contact by setting deletedAt', async () => {
    const prisma = prismaMock();
    const { service, run } = serviceWith(prisma);
    await run(() => service.remove(activeContact.id));
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { id: activeContact.id, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('never physically deletes the Contact row', async () => {
    const prisma = prismaMock();
    const { service, run } = serviceWith(prisma);
    await run(() => service.remove(activeContact.id));
    expect(prisma.contact.delete).not.toHaveBeenCalled();
  });

  it('makes repeated deletion idempotent', async () => {
    const prisma = prismaMock({ updateMany: jest.fn().mockResolvedValue({ count: 0 }) });
    const { service, run } = serviceWith(prisma);
    await expect(run(() => service.remove(activeContact.id))).resolves.toBeUndefined();
    await expect(run(() => service.remove(activeContact.id))).resolves.toBeUndefined();
  });

  it('excludes deleted contacts from normal lists and searches', async () => {
    const prisma = prismaMock();
    const { service, run } = serviceWith(prisma);
    await run(() => service.list({ search: 'Alice' }));
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
    expect(prisma.contact.count).toHaveBeenCalledWith({ where: expect.objectContaining({ deletedAt: null }) });
  });

  it('excludes deleted contacts from normal detail reads and outreach lookups', async () => {
    const prisma = prismaMock({ findFirst: jest.fn().mockResolvedValue(null) });
    const { service, run } = serviceWith(prisma);
    await expect(run(() => service.get(activeContact.id))).rejects.toThrow('Contact');
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({ where: { id: activeContact.id, deletedAt: null } });
  });

  it('reactivates the same archived row when create matches its identity', async () => {
    const archived = { ...activeContact, deletedAt: new Date('2026-02-01T00:00:00Z') };
    const restored = { ...archived, fullName: 'Alice Restored', deletedAt: null };
    const prisma = prismaMock({
      findMany: jest.fn().mockResolvedValue([archived]),
      update: jest.fn().mockResolvedValue(restored),
    });
    const { service, run } = serviceWith(prisma);
    const result = await run(() =>
      service.create({ fullName: 'Alice Restored', phone: activeContact.phone!, email: activeContact.email! }),
    );
    expect(result.id).toBe(activeContact.id);
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: activeContact.id }, data: expect.objectContaining({ deletedAt: null }) }),
    );
  });

  it('reactivates an archived identity during CSV import', async () => {
    const archived = { ...activeContact, deletedAt: new Date('2026-02-01T00:00:00Z') };
    const prisma = prismaMock({
      findFirst: jest.fn().mockResolvedValue(archived),
      update: jest.fn().mockResolvedValue({ ...archived, deletedAt: null }),
    });
    const { service, run } = serviceWith(prisma);
    const result = await run(() => service.bulkImport({ csv: 'fullName,phone\nAlice,9876543210' }));
    expect(result.updated).toBe(1);
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: null }) }),
    );
  });

  it('excludes archived contacts from tag-based audience helpers', async () => {
    const prisma = prismaMock();
    const { service, run } = serviceWith(prisma);
    await run(() => service.tags());
    expect(prisma.contact.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, select: { tags: true } });
  });

  it('keeps soft-delete updates tenant-isolated', async () => {
    const tenantContext = new TenantContext();
    const extension = createTenantIsolationExtension(tenantContext).query.$allModels.$allOperations;
    const query = jest.fn().mockResolvedValue({ count: 1 });
    await tenantContext.runWithTenant(
      {
        tenantId,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      () =>
        extension({
          model: 'Contact',
          operation: 'updateMany',
          args: { where: { id: activeContact.id, deletedAt: null }, data: { deletedAt: new Date() } },
          query,
        }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId, deletedAt: null }) }),
    );
  });
});
