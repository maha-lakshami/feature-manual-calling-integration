import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  Role,
  type InviteUserRequest,
  type TeamActivityDto,
  type TenantUserDto,
  type UpdateStaffRequest,
} from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { UsersService, type InviteResult } from './users.service';

interface ChangeRoleBody {
  role?: string;
}

interface ChangeStaffStatusBody {
  active?: boolean;
}

/**
 * Staff within the caller's own tenant — spec §4.2.
 *
 * Every route carries `staff:manage`, which the §4.2 matrix grants to a Manager and to
 * a Super Admin only "(support)" — so a platform session must pass `?tenantId=` and the
 * access is logged by `TenantAccessService`. Staff cannot reach any of it.
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  @Get()
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Members of your tenant' })
  async list(
    @CurrentUser() principal: RequestPrincipal,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantUserDto[]> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'list tenant staff', () =>
      this.users.list(),
    );
  }

  @Get('activity')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Recent staff-attributable activity within the tenant' })
  async activity(
    @CurrentUser() principal: RequestPrincipal,
    @Query('tenantId') tenantId?: string,
  ): Promise<TeamActivityDto[]> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'list tenant staff activity', () =>
      this.users.activity(),
    );
  }

  @Post()
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Invite a Manager or Staff member (spec §4.2)' })
  async invite(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: InviteUserRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<InviteResult> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'invite a tenant member', () =>
      this.users.invite(body, principal.userId, principal.role),
    );
  }

  @Patch(':membershipId')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Update a Staff profile without changing role or tenant' })
  async updateStaff(
    @CurrentUser() principal: RequestPrincipal,
    @Param('membershipId') membershipId: string,
    @Body() body: UpdateStaffRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantUserDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'edit a staff member', () =>
      this.users.updateStaff(membershipId, body),
    );
  }

  @Patch(':membershipId/status')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Deactivate or reactivate a retained Staff membership' })
  async changeStatus(
    @CurrentUser() principal: RequestPrincipal,
    @Param('membershipId') membershipId: string,
    @Body() body: ChangeStaffStatusBody,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantUserDto> {
    if (typeof body.active !== 'boolean') {
      throw new ValidationFailedException('active must be a boolean');
    }
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'change staff access status', () =>
      body.active
        ? this.users.reactivate(membershipId)
        : this.users.revoke(membershipId, principal.userId, principal.role),
    );
  }

  @Patch(':membershipId/role')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: "Change a member's role" })
  async changeRole(
    @CurrentUser() principal: RequestPrincipal,
    @Param('membershipId') membershipId: string,
    @Body() body: ChangeRoleBody,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantUserDto> {
    if (body.role !== Role.MANAGER && body.role !== Role.STAFF) {
      throw new ValidationFailedException('role must be "manager" or "staff"');
    }
    const role = body.role;

    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'change a member role', () =>
      this.users.changeRole(membershipId, role, principal.userId, principal.role),
    );
  }

  @Post(':membershipId/reset-password')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Initiate a secure password reset for a member (never returns plaintext password)' })
  async resetPassword(
    @CurrentUser() principal: RequestPrincipal,
    @Param('membershipId') membershipId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<{ ok: true; email: string; message: string }> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'reset a member password', () =>
      this.users.resetPassword(membershipId, principal.role),
    );
  }

  /**
   * Revoke a membership. `DELETE` in the HTTP sense, but the row is retained with
   * `revoked_at` set — see `UsersService.revoke`.
   */
  @Delete(':membershipId')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Revoke a member’s access (spec §4.2 "remove staff")' })
  async revoke(
    @CurrentUser() principal: RequestPrincipal,
    @Param('membershipId') membershipId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantUserDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'revoke a tenant member', () =>
      this.users.revoke(membershipId, principal.userId, principal.role),
    );
  }
}
