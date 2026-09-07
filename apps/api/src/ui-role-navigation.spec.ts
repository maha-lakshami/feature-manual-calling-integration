import { Role, permissionsFor } from '@aiking/shared';

import { navigationFor } from '../../web/src/components/layout/navigation';
import { summarizePlatformTenants } from '../../web/src/pages/platform-summary';

describe('role-specific authenticated UI policy', () => {
  it('hides tenant operations from the normal Super Admin sidebar', () => {
    const sections = navigationFor({
      role: Role.SUPER_ADMIN,
      isSuperAdmin: true,
      tenantId: null,
      permissions: permissionsFor(Role.SUPER_ADMIN, { actingOnTenant: false }),
    });
    const labels = sections.flatMap((section) => section.items.map((item) => item.label));

    expect(labels).toEqual(['Dashboard', 'Tenants & Billing']);
    expect(labels).not.toEqual(expect.arrayContaining(['Campaigns', 'Templates', 'Calls']));
  });

  it('shows Team Management to a Manager with staff:manage', () => {
    const sections = navigationFor({
      role: Role.MANAGER,
      isSuperAdmin: false,
      tenantId: 'tenant-a',
      permissions: permissionsFor(Role.MANAGER, { actingOnTenant: true }),
    });

    expect(sections.flatMap((section) => section.items.map((item) => item.label))).toContain('Team Management');
  });

  it('shows permitted operations but not Team Management to Staff', () => {
    const sections = navigationFor({
      role: Role.STAFF,
      isSuperAdmin: false,
      tenantId: 'tenant-a',
      permissions: permissionsFor(Role.STAFF, {
        actingOnTenant: true,
        tenantPolicy: { staffCanLaunchCampaigns: true, staffCanTriggerCalls: true },
      }),
    });
    const labels = sections.flatMap((section) => section.items.map((item) => item.label));

    expect(labels).toEqual(expect.arrayContaining([
      'Contacts CRM', 'Campaigns', 'Templates', 'Calls', 'Wallet & Billing',
    ]));
    expect(labels).not.toContain('Team Management');
  });

  it('derives platform dashboard values only from real tenant records', () => {
    const complete = summarizePlatformTenants([
      { id: 'a', name: 'A', slug: 'a', status: 'active', plan: 'standard', contactEmail: null, settings: {} as any, createdAt: '', wallet: { availableBalance: { rupees: 12.5 } } as any },
      { id: 'b', name: 'B', slug: 'b', status: 'suspended', plan: 'standard', contactEmail: null, settings: {} as any, createdAt: '', wallet: { availableBalance: { rupees: 7.5 } } as any },
    ]);
    expect(complete).toEqual({ total: 2, active: 1, suspended: 1, availableBalance: '₹20.00' });

    const incomplete = summarizePlatformTenants([
      { id: 'a', name: 'A', slug: 'a', status: 'active', plan: 'standard', contactEmail: null, settings: {} as any, createdAt: '' },
    ]);
    expect(incomplete.availableBalance).toBeNull();
  });
});
