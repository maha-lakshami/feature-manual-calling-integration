import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Permission, Role, permissionsFor } from '@aiking/shared';

import { CallsController } from './modules/calls/calls.controller';
import { WalletController } from './modules/wallet/wallet.controller';
import { canManageTemplates } from '../../web/src/components/common/permission-ui';
import { navigationFor } from '../../web/src/components/layout/navigation';

const webSource = (...parts: string[]) => join(process.cwd(), '..', 'web', 'src', ...parts);

function deleteHandlers(controller: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => {
    const handler = (controller.prototype as Record<string, unknown>)[name];
    return typeof handler === 'function' && Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.DELETE;
  });
}

describe('safe lifecycle and role-specific UI policy', () => {
  it('does not expose destructive delete routes for calls or wallet history', () => {
    expect(deleteHandlers(CallsController)).toEqual([]);
    expect(deleteHandlers(WalletController)).toEqual([]);
  });

  it('makes template management controls available to operational Staff', () => {
    const staffPermissions = permissionsFor(Role.STAFF, {
      actingOnTenant: true,
      tenantPolicy: { staffCanLaunchCampaigns: true },
    });
    expect(staffPermissions).toContain(Permission.CAMPAIGNS_LAUNCH);
    expect(staffPermissions).toContain(Permission.TEMPLATES_MANAGE);
    expect(canManageTemplates(staffPermissions)).toBe(true);
  });

  it('shows the Manager operational navigation and Team Management', () => {
    const labels = navigationFor({
      role: Role.MANAGER,
      isSuperAdmin: false,
      tenantId: 'tenant-a',
      permissions: permissionsFor(Role.MANAGER, { actingOnTenant: true }),
    }).flatMap((section) => section.items.map((item) => item.label));

    expect(labels).toEqual(expect.arrayContaining([
      'Contacts CRM', 'Campaigns', 'Templates', 'Calls', 'Wallet & Billing', 'Team Management',
    ]));
  });

  it('keeps developer account controls behind the Vite development flag without credentials in the page', () => {
    const source = readFileSync(webSource('pages', 'LoginPage.tsx'), 'utf8');
    expect(source).toContain('import.meta.env.DEV &&');
    expect(source).not.toMatch(/admin@aiking|manager@demo|staff@demo|demo123|admin123/);
  });

  it('defines desktop, tablet, mobile, and reduced-motion login behavior', () => {
    const css = readFileSync(webSource('pages', 'LoginPage.css'), 'utf8');
    expect(css).toContain('@media (max-width: 860px)');
    expect(css).toContain('@media (max-width: 520px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
