import { InviteStatus, Permission, Role, can } from '@aiking/shared';

import { PERMISSION_KEY } from '../../common/decorators';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

const tenantId = '11111111-1111-1111-1111-111111111111';
const managerId = '22222222-2222-2222-2222-222222222222';
const staffId = '33333333-3333-3333-3333-333333333333';
const membershipId = '44444444-4444-4444-4444-444444444444';
const now = new Date('2026-09-06T10:00:00.000Z');

const member = (overrides: Record<string, unknown> = {}) => ({
  id: membershipId,
  tenantId,
  userId: staffId,
  role: Role.STAFF,
  inviteStatus: InviteStatus.ACTIVE,
  invitedBy: managerId,
  invitedAt: now,
  acceptedAt: now,
  revokedAt: null,
  createdAt: now,
  updatedAt: now,
  user: { id: staffId, email: 'staff@example.test', fullName: 'Staff User', lastLoginAt: now },
  ...overrides,
});

describe('UsersService team management', () => {
  let prisma: any;
  let auth: any;
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      tenantUser: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
      user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      campaign: { findMany: jest.fn().mockResolvedValue([]) },
      template: { findMany: jest.fn().mockResolvedValue([]) },
      call: { findMany: jest.fn().mockResolvedValue([]) },
    };
    auth = { hashPassword: jest.fn().mockResolvedValue('hash'), revokeTenantMembershipSessions: jest.fn().mockResolvedValue(undefined) };
    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue(tenantId),
      runAsSystem: jest.fn(async (_reason: string, action: () => unknown) => await action()),
    };
    service = new UsersService(prisma, tenantContext as any, auth);
  });

  it('lists current and deactivated Staff from the scoped tenant query', async () => {
    prisma.tenantUser.findMany.mockResolvedValue([
      member(),
      member({ id: '55555555-5555-5555-5555-555555555555', inviteStatus: InviteStatus.REVOKED }),
    ]);

    const result = await service.list();

    expect(result).toHaveLength(2);
    expect(prisma.tenantUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { role: Role.STAFF } }));
  });

  it('lets a Manager add a Staff account but not a Manager account', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: staffId });
    prisma.tenantUser.create.mockResolvedValue(member({ inviteStatus: InviteStatus.INVITED }));

    const result = await service.invite(
      { email: 'staff@example.test', fullName: 'Staff User', role: Role.STAFF, password: 'StrongPass123!' },
      managerId,
      Role.MANAGER,
    );

    expect(result.member.role).toBe(Role.STAFF);
    await expect(service.invite(
      { email: 'manager@example.test', fullName: 'Manager', role: Role.MANAGER, password: 'StrongPass123!' },
      managerId,
      Role.MANAGER,
    )).rejects.toThrow('Staff accounts only');
  });

  it('edits a single-workspace Staff profile without changing email or role', async () => {
    prisma.tenantUser.findUnique.mockResolvedValue(member());
    prisma.tenantUser.count.mockResolvedValue(1);
    prisma.user.update.mockResolvedValue({ ...member().user, fullName: 'Updated Staff' });

    const result = await service.updateStaff(membershipId, { fullName: 'Updated Staff' });

    expect(result.fullName).toBe('Updated Staff');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: staffId }, data: { fullName: 'Updated Staff' } });
  });

  it('does not mutate a global Staff profile shared with another tenant', async () => {
    prisma.tenantUser.findUnique.mockResolvedValue(member());
    prisma.tenantUser.count.mockResolvedValue(2);

    await expect(service.updateStaff(membershipId, { fullName: 'Cross Tenant Name' })).rejects.toThrow(
      'multiple workspaces',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('deactivates and reactivates the same retained membership and revokes its sessions', async () => {
    const active = member();
    const revoked = member({ inviteStatus: InviteStatus.REVOKED, revokedAt: now });
    prisma.tenantUser.findUnique.mockResolvedValueOnce(active);
    prisma.tenantUser.update.mockResolvedValueOnce(revoked);

    const deactivated = await service.revoke(membershipId, managerId, Role.MANAGER);
    expect(deactivated.inviteStatus).toBe(InviteStatus.REVOKED);
    expect(auth.revokeTenantMembershipSessions).toHaveBeenCalledWith(staffId, tenantId, 'membership_revoked');

    prisma.tenantUser.findUnique.mockResolvedValueOnce(revoked);
    prisma.tenantUser.update.mockResolvedValueOnce(active);
    const reactivated = await service.reactivate(membershipId);
    expect(reactivated.inviteStatus).toBe(InviteStatus.ACTIVE);
    expect(prisma.tenantUser.update).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: membershipId } }));
  });

  it('cannot read or mutate a foreign membership hidden by tenant scope', async () => {
    prisma.tenantUser.findUnique.mockResolvedValue(null);

    await expect(service.updateStaff('foreign-membership', { fullName: 'Changed' })).rejects.toThrow('Staff member');
    await expect(service.reactivate('foreign-membership')).rejects.toThrow('Staff member');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('keeps historical attributable activity visible for deactivated Staff', async () => {
    prisma.tenantUser.findMany.mockResolvedValue([member({ inviteStatus: InviteStatus.REVOKED, revokedAt: now })]);
    prisma.campaign.findMany.mockResolvedValue([{
      id: 'campaign-1', name: 'Service Reminder', status: 'completed', createdBy: staffId, createdAt: now,
    }]);

    const result = await service.activity();

    expect(result).toEqual([expect.objectContaining({ staffUserId: staffId, staffName: 'Staff User', action: 'Created campaign' })]);
  });

  it('keeps every Team Management endpoint behind staff:manage and denies Staff', () => {
    const handlers = [
      UsersController.prototype.list,
      UsersController.prototype.activity,
      UsersController.prototype.invite,
      UsersController.prototype.updateStaff,
      UsersController.prototype.changeStatus,
      UsersController.prototype.changeRole,
      UsersController.prototype.resetPassword,
      UsersController.prototype.revoke,
    ];
    for (const handler of handlers) {
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe(Permission.STAFF_MANAGE);
    }
    expect(can(Permission.STAFF_MANAGE, Role.MANAGER)).toBe(true);
    expect(can(Permission.STAFF_MANAGE, Role.STAFF)).toBe(false);
  });
});
