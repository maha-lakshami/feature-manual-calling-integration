import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Permission, Role, can, permissionsFor } from '@aiking/shared';

import { PERMISSION_KEY } from './common/decorators';
import { CallsController } from './modules/calls/calls.controller';
import { CampaignsController } from './modules/campaigns/campaigns.controller';
import { ContactsController } from './modules/contacts/contacts.controller';
import { TopupController } from './modules/razorpay/topup.controller';
import { TemplatesController } from './modules/templates/templates.controller';
import { TenantsController } from './modules/tenants/tenants.controller';
import { UsersController } from './modules/users/users.controller';
import { WalletController } from './modules/wallet/wallet.controller';
import { navigationFor } from '../../web/src/components/layout/navigation';

const repositoryFile = (...parts: string[]) => join(process.cwd(), '..', '..', ...parts);
const webFile = (...parts: string[]) => repositoryFile('apps', 'web', 'src', ...parts);

function requiredPermission(handler: object): Permission | undefined {
  return Reflect.getMetadata(PERMISSION_KEY, handler) as Permission | undefined;
}

function routePermission(source: string, path: string): string | undefined {
  const start = source.indexOf(`path="${path}"`);
  if (start < 0) return undefined;
  return source.slice(start, start + 260).match(/requirePermission="([^"]+)"/)?.[1];
}

describe('Staff operational authorization pipeline', () => {
  const enabledPolicies = {
    staffCanLaunchCampaigns: true,
    staffCanTriggerCalls: true,
  };

  it('resolves the intended Staff capability set without management or platform authority', () => {
    const permissions = permissionsFor(Role.STAFF, {
      actingOnTenant: true,
      tenantPolicy: enabledPolicies,
    });

    expect(permissions).toEqual([
      Permission.CONTACTS_MANAGE,
      Permission.TEMPLATES_MANAGE,
      Permission.CAMPAIGNS_LAUNCH,
      Permission.CALLS_TRIGGER,
      Permission.WALLET_VIEW,
      Permission.TIMELINE_VIEW,
    ]);
    expect(permissions).not.toEqual(expect.arrayContaining([
      Permission.WALLET_TOPUP,
      Permission.STAFF_MANAGE,
      Permission.TENANT_ONBOARD,
      Permission.TENANT_SUSPEND,
      Permission.BILLING_VIEW_CROSS_TENANT,
      Permission.PLATFORM_CONFIG,
    ]));
  });

  it('keeps campaign and call spend-capable actions controlled by tenant policy', () => {
    expect(can(Permission.TEMPLATES_MANAGE, Role.STAFF)).toBe(true);
    expect(can(Permission.CAMPAIGNS_LAUNCH, Role.STAFF)).toBe(false);
    expect(can(Permission.CALLS_TRIGGER, Role.STAFF)).toBe(false);
    expect(can(Permission.CAMPAIGNS_LAUNCH, Role.STAFF, { tenantPolicy: enabledPolicies })).toBe(true);
    expect(can(Permission.CALLS_TRIGGER, Role.STAFF, { tenantPolicy: enabledPolicies })).toBe(true);
  });

  it('protects operational APIs with their matching capabilities', () => {
    for (const handler of [ContactsController.prototype.list, ContactsController.prototype.create, ContactsController.prototype.update]) {
      expect(requiredPermission(handler)).toBe(Permission.CONTACTS_MANAGE);
    }
    for (const handler of [
      TemplatesController.prototype.list,
      TemplatesController.prototype.get,
      TemplatesController.prototype.create,
      TemplatesController.prototype.update,
      TemplatesController.prototype.generateWithAutopilot,
      TemplatesController.prototype.modifyWithAutopilot,
    ]) {
      expect(requiredPermission(handler)).toBe(Permission.TEMPLATES_MANAGE);
    }
    for (const handler of [CampaignsController.prototype.list, CampaignsController.prototype.create, CampaignsController.prototype.launch]) {
      expect(requiredPermission(handler)).toBe(Permission.CAMPAIGNS_LAUNCH);
    }
    for (const handler of [CallsController.prototype.list, CallsController.prototype.place]) {
      expect(requiredPermission(handler)).toBe(Permission.CALLS_TRIGGER);
    }
    for (const handler of [WalletController.prototype.view, WalletController.prototype.summary]) {
      expect(requiredPermission(handler)).toBe(Permission.WALLET_VIEW);
    }
  });

  it('keeps top-up, team, tenant, cross-tenant billing, and platform capabilities denied to Staff', () => {
    expect(requiredPermission(TopupController.prototype.create)).toBe(Permission.WALLET_TOPUP);
    expect(requiredPermission(UsersController.prototype.list)).toBe(Permission.STAFF_MANAGE);
    expect(requiredPermission(UsersController.prototype.invite)).toBe(Permission.STAFF_MANAGE);
    expect(requiredPermission(UsersController.prototype.changeStatus)).toBe(Permission.STAFF_MANAGE);
    expect(requiredPermission(TenantsController.prototype.onboard)).toBe(Permission.TENANT_ONBOARD);
    expect(requiredPermission(TenantsController.prototype.suspend)).toBe(Permission.TENANT_SUSPEND);
    expect(requiredPermission(TenantsController.prototype.list)).toBe(Permission.BILLING_VIEW_CROSS_TENANT);
    expect(requiredPermission(TenantsController.prototype.updateSettings)).toBe(Permission.PLATFORM_CONFIG);
  });

  it('renders Staff navigation from resolved capabilities and excludes Team Management', () => {
    const labels = navigationFor({
      role: Role.STAFF,
      isSuperAdmin: false,
      tenantId: 'tenant-a',
      permissions: permissionsFor(Role.STAFF, { actingOnTenant: true, tenantPolicy: enabledPolicies }),
    }).flatMap((section) => section.items.map((item) => item.label));

    expect(labels).toEqual([
      'Dashboard',
      'Contacts CRM',
      'Campaigns',
      'Templates',
      'Calls',
      'Wallet & Billing',
    ]);
    expect(labels).not.toContain('Team Management');
    expect(labels).not.toContain('Tenants & Billing');
  });

  it('keeps Manager capabilities and platform Super Admin context unchanged', () => {
    const manager = permissionsFor(Role.MANAGER, { actingOnTenant: true });
    expect(manager).toEqual(expect.arrayContaining([
      Permission.CONTACTS_MANAGE,
      Permission.TEMPLATES_MANAGE,
      Permission.CAMPAIGNS_LAUNCH,
      Permission.CALLS_TRIGGER,
      Permission.WALLET_VIEW,
      Permission.WALLET_TOPUP,
      Permission.TIMELINE_VIEW,
      Permission.STAFF_MANAGE,
    ]));

    const platformNavigation = navigationFor({
      role: Role.SUPER_ADMIN,
      isSuperAdmin: true,
      tenantId: null,
      permissions: permissionsFor(Role.SUPER_ADMIN, { actingOnTenant: false }),
    }).flatMap((section) => section.items.map((item) => item.label));
    expect(platformNavigation).toEqual(['Dashboard', 'Tenants & Billing']);
  });

  it('maps direct operational routes to the same permissions as their APIs', () => {
    const source = readFileSync(webFile('App.tsx'), 'utf8');

    expect(routePermission(source, '/wallet')).toBe(Permission.WALLET_VIEW);
    expect(routePermission(source, '/contacts')).toBe(Permission.CONTACTS_MANAGE);
    expect(routePermission(source, '/contacts/:id')).toBe(Permission.CONTACTS_MANAGE);
    expect(routePermission(source, '/templates')).toBe(Permission.TEMPLATES_MANAGE);
    expect(routePermission(source, '/campaigns')).toBe(Permission.CAMPAIGNS_LAUNCH);
    expect(routePermission(source, '/calls')).toBe(Permission.CALLS_TRIGGER);
    expect(routePermission(source, '/team')).toBe(Permission.STAFF_MANAGE);
  });

  it('uses matching action-level permissions for operational controls', () => {
    expect(readFileSync(webFile('pages', 'ContactsPage.tsx'), 'utf8')).toContain("permissions.includes('contacts:manage')");
    expect(readFileSync(webFile('pages', 'TemplatesPage.tsx'), 'utf8')).toContain('canManageTemplates');
    expect(readFileSync(webFile('pages', 'CampaignsPage.tsx'), 'utf8')).toContain("permissions.includes('campaigns:launch')");
    expect(readFileSync(webFile('pages', 'CallsPage.tsx'), 'utf8')).toContain("permissions.includes('calls:trigger')");
    expect(readFileSync(webFile('pages', 'WalletPage.tsx'), 'utf8')).toContain("permissions.includes('wallet:topup')");
  });

  it('updates existing Demo tenant policy flags when the development seed is rerun', () => {
    const source = readFileSync(repositoryFile('apps', 'api', 'prisma', 'seed.ts'), 'utf8');
    const demoTenantUpsert = source.slice(
      source.indexOf("where: { slug: 'demo-logistics' }"),
      source.indexOf('const managerHash'),
    );

    expect(demoTenantUpsert).toMatch(/update:\s*{[\s\S]*staffCanLaunchCampaigns:\s*true/);
    expect(demoTenantUpsert).toMatch(/update:\s*{[\s\S]*staffCanTriggerCalls:\s*true/);
  });
});
