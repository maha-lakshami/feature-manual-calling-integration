import type { Permission } from '@aiking/shared';

export function hasPermission(permissions: readonly Permission[] | undefined, permission: Permission): boolean {
  return permissions?.includes(permission) === true;
}

export function canManageTemplates(permissions: readonly Permission[] | undefined): boolean {
  return hasPermission(permissions, 'templates:manage');
}
