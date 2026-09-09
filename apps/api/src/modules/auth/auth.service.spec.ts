import { Role } from '@aiking/shared';

import { TenantContext } from '../../common/tenant/tenant-context';
import { AuthService } from './auth.service';

describe('AuthService memberships', () => {
  it('executes Prisma\'s lazy membership query inside the system context', async () => {
    const tenantContext = new TenantContext();
    let contextObservedByQuery: string | undefined;
    const rows = [
      {
        tenantId: '11111111-1111-1111-1111-111111111111',
        role: Role.MANAGER,
        tenant: { name: 'Tenant A', slug: 'tenant-a' },
      },
      {
        tenantId: '22222222-2222-2222-2222-222222222222',
        role: Role.MANAGER,
        tenant: { name: 'Tenant B', slug: 'tenant-b' },
      },
    ];
    const lazyQuery = {
      then<TResult1 = typeof rows, TResult2 = never>(
        onfulfilled?: ((value: typeof rows) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        contextObservedByQuery = tenantContext.unscoped?.kind;
        return Promise.resolve(rows).then(onfulfilled, onrejected);
      },
    };
    const prisma = { tenantUser: { findMany: jest.fn().mockReturnValue(lazyQuery) } };
    const service = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      tenantContext,
      {} as never,
    );

    const result = await tenantContext.runWithTenant(
      {
        tenantId: '11111111-1111-1111-1111-111111111111',
        userId: '33333333-3333-3333-3333-333333333333',
        role: Role.MANAGER,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      () => service.memberships('33333333-3333-3333-3333-333333333333'),
    );

    expect(contextObservedByQuery).toBe('system');
    expect(result).toHaveLength(2);
    expect(result.map((membership) => membership.slug)).toEqual(['tenant-a', 'tenant-b']);
  });
});
