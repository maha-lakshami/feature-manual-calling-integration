import { TenantContext } from '../tenant/tenant-context';
import { createTenantIsolationExtension } from './prisma.service';

describe('PrismaService Tenant Isolation', () => {
  let tenantContext: TenantContext;

  beforeEach(() => {
    tenantContext = new TenantContext();
  });

  it('rejects createMany when caller provides a mismatched tenantId', async () => {
    const trustedTenantId = '11111111-1111-1111-1111-111111111111';
    const maliciousTenantId = '22222222-2222-2222-2222-222222222222';

    const extension = createTenantIsolationExtension(tenantContext).query.$allModels.$allOperations;

    await tenantContext.runWithTenant(
      {
        tenantId: trustedTenantId,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => {
        await expect(
          extension({
            model: 'Contact',
            operation: 'createMany',
            args: {
              data: [
                { fullName: 'Alice', tenantId: trustedTenantId },
                { fullName: 'Bob', tenantId: maliciousTenantId },
              ],
            },
            query: jest.fn(),
          }),
        ).rejects.toThrow(/does not match the active tenant scope/);
      },
    );
  });

  it('accepts createMany when tenantId is omitted and stamps trusted tenantId', async () => {
    const trustedTenantId = '11111111-1111-1111-1111-111111111111';

    let capturedArgs: any;
    const mockQuery = jest.fn().mockImplementation(async (args) => {
      capturedArgs = args;
      return { count: 2 };
    });

    const extension = createTenantIsolationExtension(tenantContext).query.$allModels.$allOperations;

    await tenantContext.runWithTenant(
      {
        tenantId: trustedTenantId,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => {
        const result = await extension({
          model: 'Contact',
          operation: 'createMany',
          args: {
            data: [{ fullName: 'Alice' }, { fullName: 'Bob' }],
          },
          query: mockQuery,
        });

        expect(result).toEqual({ count: 2 });
        expect(capturedArgs.data).toEqual([
          { fullName: 'Alice', tenantId: trustedTenantId },
          { fullName: 'Bob', tenantId: trustedTenantId },
        ]);
      },
    );
  });

  it('accepts createMany when tenantId explicitly matches trusted tenantId', async () => {
    const trustedTenantId = '11111111-1111-1111-1111-111111111111';

    let capturedArgs: any;
    const mockQuery = jest.fn().mockImplementation(async (args) => {
      capturedArgs = args;
      return { count: 1 };
    });

    const extension = createTenantIsolationExtension(tenantContext).query.$allModels.$allOperations;

    await tenantContext.runWithTenant(
      {
        tenantId: trustedTenantId,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => {
        await extension({
          model: 'Contact',
          operation: 'createMany',
          args: {
            data: [{ fullName: 'Alice', tenantId: trustedTenantId }],
          },
          query: mockQuery,
        });

        expect(capturedArgs.data[0].tenantId).toBe(trustedTenantId);
      },
    );
  });

  it('rejects create with mismatched explicit tenantId', async () => {
    const trustedTenantId = '11111111-1111-1111-1111-111111111111';
    const maliciousTenantId = '22222222-2222-2222-2222-222222222222';

    const extension = createTenantIsolationExtension(tenantContext).query.$allModels.$allOperations;

    await tenantContext.runWithTenant(
      {
        tenantId: trustedTenantId,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => {
        await expect(
          extension({
            model: 'Contact',
            operation: 'create',
            args: {
              data: { fullName: 'Mallory', tenantId: maliciousTenantId },
            },
            query: jest.fn(),
          }),
        ).rejects.toThrow(/does not match the active tenant scope/);
      },
    );
  });

  it('rejects where filter with mismatched explicit tenantId', async () => {
    const trustedTenantId = '11111111-1111-1111-1111-111111111111';
    const maliciousTenantId = '22222222-2222-2222-2222-222222222222';

    const extension = createTenantIsolationExtension(tenantContext).query.$allModels.$allOperations;

    await tenantContext.runWithTenant(
      {
        tenantId: trustedTenantId,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => {
        await expect(
          extension({
            model: 'Contact',
            operation: 'findMany',
            args: {
              where: { tenantId: maliciousTenantId },
            },
            query: jest.fn(),
          }),
        ).rejects.toThrow(/does not match the active tenant scope/);
      },
    );
  });

  it('rejects upsert with mismatched explicit tenantId in create or update', async () => {
    const trustedTenantId = '11111111-1111-1111-1111-111111111111';
    const maliciousTenantId = '22222222-2222-2222-2222-222222222222';

    const extension = createTenantIsolationExtension(tenantContext).query.$allModels.$allOperations;

    await tenantContext.runWithTenant(
      {
        tenantId: trustedTenantId,
        userId: 'user-1',
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      async () => {
        await expect(
          extension({
            model: 'Contact',
            operation: 'upsert',
            args: {
              where: { id: 'contact-1' },
              create: { fullName: 'Alice', tenantId: maliciousTenantId },
              update: { fullName: 'Alice' },
            },
            query: jest.fn(),
          }),
        ).rejects.toThrow(/does not match the active tenant scope/);
      },
    );
  });
});
