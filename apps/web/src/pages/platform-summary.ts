import type { TenantDto } from '@aiking/shared';

export interface PlatformSummary {
  total: number;
  active: number;
  suspended: number;
  availableBalance: string | null;
}

export function summarizePlatformTenants(tenants: TenantDto[]): PlatformSummary {
  const hasCompleteWalletData = tenants.every((tenant) => Boolean(tenant.wallet?.availableBalance));
  const availableRupees = tenants.reduce(
    (total, tenant) => total + (tenant.wallet?.availableBalance?.rupees ?? 0),
    0,
  );

  return {
    total: tenants.length,
    active: tenants.filter((tenant) => tenant.status === 'active').length,
    suspended: tenants.filter((tenant) => tenant.status === 'suspended').length,
    availableBalance: hasCompleteWalletData
      ? `₹${availableRupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : null,
  };
}
