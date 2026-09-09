import { Permission, Role, TenantPolicyKey, can, decide } from '@aiking/shared';

import { PERMISSION_KEY, PUBLIC_KEY, WEBHOOK_KEY } from '../../common/decorators';
import { CampaignsController } from '../campaigns/campaigns.controller';
import { TemplatesController } from './templates.controller';

const templateManagementHandlers = [
  TemplatesController.prototype.create,
  TemplatesController.prototype.update,
  TemplatesController.prototype.submit,
  TemplatesController.prototype.pause,
  TemplatesController.prototype.remove,
  TemplatesController.prototype.generateWithAutopilot,
  TemplatesController.prototype.modifyWithAutopilot,
] as const;

describe('template management authorization', () => {
  it('assigns templates:manage to Super Admin support, Manager, and Staff', () => {
    expect(decide(Permission.TEMPLATES_MANAGE, Role.SUPER_ADMIN)).toBe('allow_as_support');
    expect(can(Permission.TEMPLATES_MANAGE, Role.SUPER_ADMIN, { actingOnTenant: true })).toBe(true);
    expect(can(Permission.TEMPLATES_MANAGE, Role.SUPER_ADMIN, { actingOnTenant: false })).toBe(false);
    expect(can(Permission.TEMPLATES_MANAGE, Role.MANAGER)).toBe(true);
    expect(can(Permission.TEMPLATES_MANAGE, Role.STAFF)).toBe(true);
  });

  it('requires templates:manage for create, edit, lifecycle, and both Autopilot actions', () => {
    for (const handler of templateManagementHandlers) {
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe(Permission.TEMPLATES_MANAGE);
    }
  });

  it('keeps campaign launch policy separate from template management', () => {
    const tenantPolicy = { [TenantPolicyKey.STAFF_CAN_LAUNCH_CAMPAIGNS]: true };

    expect(can(Permission.CAMPAIGNS_LAUNCH, Role.STAFF, { tenantPolicy })).toBe(true);
    expect(can(Permission.TEMPLATES_MANAGE, Role.STAFF)).toBe(true);
    expect(Permission.TEMPLATES_MANAGE).not.toBe(Permission.CAMPAIGNS_LAUNCH);
  });

  it('does not let templates:manage replace campaign launch authorization', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, TemplatesController.prototype.create)).toBe(
      Permission.TEMPLATES_MANAGE,
    );
    expect(Reflect.getMetadata(PERMISSION_KEY, CampaignsController.prototype.launch)).toBe(
      Permission.CAMPAIGNS_LAUNCH,
    );
    expect(Permission.TEMPLATES_MANAGE).not.toBe(Permission.CAMPAIGNS_LAUNCH);
  });

  it('uses templates:manage for template reads as well as writes', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, TemplatesController.prototype.list)).toBe(
      Permission.TEMPLATES_MANAGE,
    );
    expect(Reflect.getMetadata(PERMISSION_KEY, TemplatesController.prototype.get)).toBe(
      Permission.TEMPLATES_MANAGE,
    );
  });

  it('keeps all template-management routes authenticated rather than public or webhook routes', () => {
    for (const handler of templateManagementHandlers) {
      expect(Reflect.getMetadata(PUBLIC_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(WEBHOOK_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe(Permission.TEMPLATES_MANAGE);
    }
  });
});
