import type { Permission, Role } from '@aiking/shared';

export interface NavigationIdentity {
  role: Role;
  isSuperAdmin: boolean;
  tenantId: string | null;
  permissions: Permission[];
}

export interface NavigationItem {
  label: string;
  path: string;
  icon: 'dashboard' | 'contacts' | 'campaigns' | 'templates' | 'calls' | 'wallet' | 'tenants' | 'team';
}

export interface NavigationSection {
  label: string;
  items: NavigationItem[];
}

export function navigationFor(user: NavigationIdentity): NavigationSection[] {
  if (user.isSuperAdmin && !user.tenantId) {
    return [
      { label: 'Overview', items: [{ label: 'Dashboard', path: '/', icon: 'dashboard' }] },
      { label: 'Platform', items: [{ label: 'Tenants & Billing', path: '/tenants', icon: 'tenants' }] },
    ];
  }

  const permissions = new Set(user.permissions);
  const operations: NavigationItem[] = [];

  if (permissions.has('contacts:manage')) {
    operations.push({ label: 'Contacts CRM', path: '/contacts', icon: 'contacts' });
  }
  if (permissions.has('campaigns:launch')) {
    operations.push({ label: 'Campaigns', path: '/campaigns', icon: 'campaigns' });
  }
  if (permissions.has('templates:manage')) {
    operations.push({ label: 'Templates', path: '/templates', icon: 'templates' });
  }
  if (permissions.has('calls:trigger')) {
    operations.push({ label: 'Calls', path: '/calls', icon: 'calls' });
  }
  if (permissions.has('wallet:view')) {
    operations.push({ label: 'Wallet & Billing', path: '/wallet', icon: 'wallet' });
  }

  const sections: NavigationSection[] = [
    { label: 'Overview', items: [{ label: 'Dashboard', path: '/', icon: 'dashboard' }] },
  ];
  if (operations.length > 0) sections.push({ label: 'Operations', items: operations });
  if (permissions.has('staff:manage')) {
    sections.push({ label: 'Team', items: [{ label: 'Team Management', path: '/team', icon: 'team' }] });
  }
  return sections;
}
