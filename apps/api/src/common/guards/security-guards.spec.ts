import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InviteStatus, Role, TenantStatus } from '@prisma/client';
import { Permission } from '@aiking/shared';

import { JwtAuthGuard } from './jwt-auth.guard';
import { TenantGuard } from './tenant.guard';
import { RolesGuard } from './roles.guard';
import {
  CrossTenantAccessException,
  ForbiddenRoleException,
  ForbiddenTenantPolicyException,
  TenantSuspendedException,
  UnauthorizedException,
} from '../errors/app-exception';
import { PERMISSION_KEY, PUBLIC_KEY, ROLES_KEY, WEBHOOK_KEY } from '../decorators';

describe('Global Security Guard Pipeline', () => {
  let reflector: Reflector;
  let mockPrisma: any;
  let mockTenantSettings: any;

  let jwtGuard: JwtAuthGuard;
  let tenantGuard: TenantGuard;
  let rolesGuard: RolesGuard;

  const validTenantId = '11111111-1111-1111-1111-111111111111';
  const otherTenantId = '22222222-2222-2222-2222-222222222222';
  const validUserId = 'user-123';

  beforeEach(() => {
    reflector = new Reflector();

    mockPrisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: validUserId, isActive: true }),
      },
      session: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sess-1', expiresAt: new Date(Date.now() + 10000), revokedAt: null }),
      },
      tenantUser: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tu-1', inviteStatus: InviteStatus.active, role: Role.manager }),
      },
    };

    mockTenantSettings = {
      get: jest.fn().mockResolvedValue({
        id: validTenantId,
        name: 'Valid Tenant',
        status: TenantStatus.active,
        settings: {
          staffCanLaunchCampaigns: false,
          staffCanTriggerCalls: false,
        },
      }),
    };

    jwtGuard = new JwtAuthGuard(reflector, mockPrisma);
    tenantGuard = new TenantGuard(reflector, mockTenantSettings, mockPrisma);
    rolesGuard = new RolesGuard(reflector, mockTenantSettings);
  });

  function createMockContext(options: {
    principal?: any;
    isPublic?: boolean;
    isWebhook?: boolean;
    requiredPermission?: Permission;
    allowedRoles?: Role[];
    params?: Record<string, string>;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, any>;
  }): ExecutionContext {
    const req: any = {
      principal: options.principal,
      params: options.params ?? {},
      headers: options.headers ?? {},
      query: options.query ?? {},
      body: options.body ?? {},
      method: 'GET',
      originalUrl: '/test',
    };

    const handler = () => {};
    const controller = class TestController {};

    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: any) => {
      if (key === PUBLIC_KEY) return options.isPublic ? 'public route' : undefined;
      if (key === WEBHOOK_KEY) return options.isWebhook ? 'meta' : undefined;
      if (key === PERMISSION_KEY) return options.requiredPermission;
      if (key === ROLES_KEY) return options.allowedRoles;
      return undefined;
    });

    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
      getHandler: () => handler,
      getClass: () => controller,
    } as unknown as ExecutionContext;
  }

  // ── 1. Unauthenticated requests ───────────────────────────────────────────
  it('rejects unauthenticated request on protected route with 401', async () => {
    const ctx = createMockContext({
      principal: undefined,
      requiredPermission: Permission.CONTACTS_MANAGE,
    });

    await expect(jwtGuard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── 2. Public bypass ──────────────────────────────────────────────────────
  it('allows public route without JWT authentication', async () => {
    const ctx = createMockContext({
      isPublic: true,
      principal: undefined,
    });

    expect(await jwtGuard.canActivate(ctx)).toBe(true);
    expect(await tenantGuard.canActivate(ctx)).toBe(true);
    expect(await rolesGuard.canActivate(ctx)).toBe(true);
  });

  // ── 3. Webhook bypass of end-user JWT ─────────────────────────────────────
  it('allows webhook route through guards without user JWT', async () => {
    const ctx = createMockContext({
      isWebhook: true,
      principal: undefined,
    });

    expect(await jwtGuard.canActivate(ctx)).toBe(true);
    expect(await tenantGuard.canActivate(ctx)).toBe(true);
    expect(await rolesGuard.canActivate(ctx)).toBe(true);
  });

  // ── 4. Cross-tenant access attempts ───────────────────────────────────────
  it('denies Tenant A token requesting Tenant B resource with 403 CrossTenantAccessException', async () => {
    const ctx = createMockContext({
      principal: {
        userId: validUserId,
        email: 'user@a.example',
        name: 'User A',
        role: Role.manager,
        tenantId: validTenantId,
        isSuperAdmin: false,
      },
      params: { tenantId: otherTenantId },
    });

    await expect(tenantGuard.canActivate(ctx)).rejects.toThrow(CrossTenantAccessException);
  });

  // ── 5. Suspended tenant access ───────────────────────────────────────────
  it('denies access to a suspended tenant with 403 TenantSuspendedException', async () => {
    mockTenantSettings.get.mockResolvedValueOnce({
      id: validTenantId,
      name: 'Suspended Corp',
      status: TenantStatus.suspended,
      settings: {},
    });

    const ctx = createMockContext({
      principal: {
        userId: validUserId,
        email: 'user@suspended.example',
        name: 'Suspended User',
        role: Role.manager,
        tenantId: validTenantId,
        isSuperAdmin: false,
      },
    });

    await expect(tenantGuard.canActivate(ctx)).rejects.toThrow(TenantSuspendedException);
  });

  // ── 6. Disabled / Deactivated user ────────────────────────────────────────
  it('denies access to a deactivated user with 401 UnauthorizedException', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({ id: validUserId, isActive: false });

    const ctx = createMockContext({
      principal: {
        userId: validUserId,
        email: 'disabled@example.com',
        name: 'Disabled User',
        role: Role.manager,
        tenantId: validTenantId,
        isSuperAdmin: false,
      },
    });

    await expect(jwtGuard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── 7. Revoked tenant membership ──────────────────────────────────────────
  it('denies access when tenant membership has been revoked with 401 UnauthorizedException', async () => {
    mockPrisma.tenantUser.findUnique.mockResolvedValueOnce({
      id: 'tu-1',
      inviteStatus: InviteStatus.revoked,
      role: Role.staff,
    });

    const ctx = createMockContext({
      principal: {
        userId: validUserId,
        email: 'revoked@example.com',
        name: 'Revoked Staff',
        role: Role.staff,
        tenantId: validTenantId,
        isSuperAdmin: false,
      },
    });

    await expect(tenantGuard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── 8. Missing required permission (outright role denial) ─────────────────
  it('denies access when caller lacks the required permission with 403 ForbiddenRoleException', async () => {
    const ctx = createMockContext({
      principal: {
        userId: validUserId,
        email: 'staff@example.com',
        name: 'Staff Member',
        role: Role.staff,
        tenantId: validTenantId,
        isSuperAdmin: false,
      },
      requiredPermission: Permission.STAFF_MANAGE, // Staff is outright denied STAFF_MANAGE
    });

    await expect(rolesGuard.canActivate(ctx)).rejects.toThrow(ForbiddenRoleException);
  });

  // ── 8b. Missing required permission via tenant policy ─────────────────────
  it('denies access when caller lacks tenant policy permission with 403 ForbiddenTenantPolicyException', async () => {
    const ctx = createMockContext({
      principal: {
        userId: validUserId,
        email: 'staff@example.com',
        name: 'Staff Member',
        role: Role.staff,
        tenantId: validTenantId,
        isSuperAdmin: false,
      },
      requiredPermission: Permission.CAMPAIGNS_LAUNCH, // Staff cannot launch without tenant policy enabled
    });

    await expect(rolesGuard.canActivate(ctx)).rejects.toThrow(ForbiddenTenantPolicyException);
  });

  it('permits Staff campaign and call operations when the tenant policies are enabled', async () => {
    mockTenantSettings.get.mockResolvedValue({
      id: validTenantId,
      name: 'Operational Tenant',
      status: TenantStatus.active,
      settings: {
        staffCanLaunchCampaigns: true,
        staffCanTriggerCalls: true,
      },
    });
    const principal = {
      userId: validUserId,
      email: 'staff@example.com',
      name: 'Staff Member',
      role: Role.staff,
      tenantId: validTenantId,
      isSuperAdmin: false,
    };

    expect(await rolesGuard.canActivate(createMockContext({
      principal,
      requiredPermission: Permission.CAMPAIGNS_LAUNCH,
    }))).toBe(true);
    expect(await rolesGuard.canActivate(createMockContext({
      principal,
      requiredPermission: Permission.CALLS_TRIGGER,
    }))).toBe(true);
  });

  // ── 9. Valid authenticated and authorized tenant request ──────────────────
  it('permits valid authenticated and authorized tenant request', async () => {
    const ctx = createMockContext({
      principal: {
        userId: validUserId,
        email: 'manager@example.com',
        name: 'Manager Member',
        role: Role.manager,
        tenantId: validTenantId,
        isSuperAdmin: false,
      },
      requiredPermission: Permission.CONTACTS_MANAGE,
    });

    expect(await jwtGuard.canActivate(ctx)).toBe(true);
    expect(await tenantGuard.canActivate(ctx)).toBe(true);
    expect(await rolesGuard.canActivate(ctx)).toBe(true);
  });
});
