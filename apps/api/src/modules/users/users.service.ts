import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InviteStatus,
  Role,
  type InviteUserRequest,
  type TeamActivityDto,
  type TenantUserDto,
  type UpdateStaffRequest,
} from '@aiking/shared';

import {
  ConflictingDuplicateException,
  NotFoundException,
  ValidationFailedException,
} from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient, isUniqueViolation } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { AuthService, assertPasswordStrength } from '../auth/auth.service';

export interface InviteResult {
  member: TenantUserDto;
  /** Returned once, only for a newly created account. */
  temporaryPassword?: string;
}

/**
 * Staff management within one tenant — spec §4.2 "Invite / remove staff within own
 * tenant".
 *
 * Every method here operates on the ambient tenant scope, never on a tenant named by
 * the caller. A Manager therefore cannot enumerate or modify another tenant's members
 * even by guessing a membership id: the Prisma extension adds `tenant_id` to the
 * `where` clause, so a foreign id matches nothing.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly auth: AuthService,
  ) {}

  /** Members of the caller's tenant. */
  async list(): Promise<TenantUserDto[]> {
    const rows = await this.prisma.tenantUser.findMany({
      // Team Management is intentionally a staff lifecycle view. Revoked rows remain
      // visible so Managers can reactivate access and historical attribution survives.
      where: { role: Role.STAFF },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toTenantUserDto);
  }

  /**
   * Invite a Manager or Staff member.
   *
   * `super_admin` is not accepted: it is a flag on `users`, not a tenant role, and
   * granting it from a tenant-scoped endpoint would be a privilege escalation out of
   * the tenant into the platform.
   *
   * The user row is global (§9.3), so an email that already exists gets a *membership*
   * rather than a second account — that is how one person holds a role in two tenants.
   */
  async invite(request: InviteUserRequest, invitedByUserId: string, actorRole: Role): Promise<InviteResult> {
    const tenantId = this.tenantContext.requireTenantId('users.invite');
    const email = (request.email ?? '').trim().toLowerCase();

    if (!email.includes('@')) {
      throw new ValidationFailedException('A valid email is required', { email });
    }
    if (request.role !== Role.MANAGER && request.role !== Role.STAFF) {
      throw new ValidationFailedException('A tenant member is either a manager or staff', {
        allowed: [Role.MANAGER, Role.STAFF],
      });
    }
    if (actorRole === Role.MANAGER && request.role !== Role.STAFF) {
      throw new ValidationFailedException('Managers can invite Staff accounts only');
    }

    const temporaryPassword = request.password?.trim() || generatePassword();
    assertPasswordStrength(temporaryPassword);

    // Global `users` lookup — deliberately outside the tenant scope, because the point
    // is to find an account that may belong to a different tenant entirely.
    const existing = await this.tenantContext.runAsSystem('look up a global user account by email', () =>
      this.prisma.user.findUnique({
        where: { email },
        include: { tenantUsers: { where: { tenantId } } },
      }),
    );

    if (existing?.tenantUsers.length) {
      const membership = existing.tenantUsers[0]!;

      // A previously revoked member is reinstated rather than duplicated — the UNIQUE
      // on (tenant_id, user_id) means there is only ever one row to reinstate.
      if (membership.inviteStatus === InviteStatus.REVOKED) {
        const restored = await this.prisma.tenantUser.update({
          where: { id: membership.id },
          data: {
            role: request.role,
            inviteStatus: InviteStatus.INVITED,
            invitedBy: invitedByUserId,
            invitedAt: new Date(),
            revokedAt: null,
            acceptedAt: null,
          },
          include: { user: true },
        });
        this.logger.log(`reinstated ${email} as ${request.role} on tenant ${tenantId}`);
        return { member: toTenantUserDto(restored) };
      }

      throw new ConflictingDuplicateException(`${email} is already a member of this tenant`);
    }

    const userId =
      existing?.id ??
      (
        await this.tenantContext.runAsSystem('create a global user account', async () =>
          this.prisma.user.create({
            data: {
              email,
              fullName: request.fullName?.trim() || email,
              passwordHash: await this.auth.hashPassword(temporaryPassword),
            },
          }),
        )
      ).id;

    const created = await this.prisma.tenantUser
      .create({
        data: { tenantId, userId, role: request.role, inviteStatus: InviteStatus.INVITED, invitedBy: invitedByUserId },
        include: { user: true },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictingDuplicateException(`${email} is already a member of this tenant`);
        }
        throw error;
      });

    this.logger.log(`invited ${email} as ${request.role} to tenant ${tenantId}`);

    return {
      member: toTenantUserDto(created),
      // Only ever disclosed for an account this call created. An existing user's
      // password is theirs and is not reset by being added to another tenant.
      temporaryPassword: existing ? undefined : temporaryPassword,
    };
  }

  /**
   * Revoke a membership — the spec's "remove staff".
   *
   * The membership row is kept with `revoked_at` set rather than deleted, because
   * `campaigns.created_by` and `wallet_transactions.created_by` point at the user: a
   * hard delete would leave a campaign nobody launched and a debit nobody authorised.
   */
  async revoke(membershipId: string, actorUserId: string, actorRole: Role): Promise<TenantUserDto> {
    const membership = await this.prisma.tenantUser.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('Tenant member', membershipId);

    if (actorRole === Role.MANAGER && membership.role !== Role.STAFF) {
      throw new ValidationFailedException('Managers can deactivate Staff accounts only');
    }

    if (membership.userId === actorUserId) {
      throw new ValidationFailedException(
        'You cannot revoke your own membership — ask another Manager or the platform Super Admin',
      );
    }

    // Refusing to remove the last Manager is not paternalism: a tenant with no Manager
    // has nobody who can top up the wallet or invite a replacement (§4.2), so the
    // account would need platform intervention to recover.
    if (membership.role === Role.MANAGER) {
      const activeManagers = await this.prisma.tenantUser.count({
        where: { role: Role.MANAGER, inviteStatus: { not: InviteStatus.REVOKED } },
      });
      if (activeManagers <= 1) {
        throw new ValidationFailedException('A tenant must keep at least one Manager');
      }
    }

    const revoked = await this.prisma.tenantUser.update({
      where: { id: membershipId },
      data: { inviteStatus: InviteStatus.REVOKED, revokedAt: new Date() },
      include: { user: true },
    });

    // Revoke active sessions for this user on this tenant
    await this.auth.revokeTenantMembershipSessions(membership.userId, membership.tenantId, 'membership_revoked');

    this.logger.warn(`revoked ${membership.user.email} from tenant ${membership.tenantId}`);
    return toTenantUserDto(revoked);
  }

  /** Change a member's role between manager and staff. */
  async changeRole(membershipId: string, role: Role, actorUserId: string, actorRole: Role): Promise<TenantUserDto> {
    if (role !== Role.MANAGER && role !== Role.STAFF) {
      throw new ValidationFailedException('A tenant member is either a manager or staff');
    }

    const membership = await this.prisma.tenantUser.findUnique({ where: { id: membershipId } });
    if (!membership) throw new NotFoundException('Tenant member', membershipId);

    if (actorRole === Role.MANAGER && (membership.role !== Role.STAFF || role !== Role.STAFF)) {
      throw new ValidationFailedException('Managers cannot promote or modify Manager accounts');
    }

    if (membership.userId === actorUserId && role === Role.STAFF) {
      throw new ValidationFailedException('You cannot demote yourself out of the Manager role');
    }

    if (membership.role === Role.MANAGER && role === Role.STAFF) {
      const activeManagers = await this.prisma.tenantUser.count({
        where: { role: Role.MANAGER, inviteStatus: { not: InviteStatus.REVOKED } },
      });
      if (activeManagers <= 1) {
        throw new ValidationFailedException('A tenant must keep at least one Manager');
      }
    }

    const updated = await this.prisma.tenantUser.update({
      where: { id: membershipId },
      data: { role },
      include: { user: true },
    });

    // Revoke active sessions for this user on this tenant so the new role is immediately reflected
    await this.auth.revokeTenantMembershipSessions(membership.userId, membership.tenantId, 'role_changed');

    this.logger.log(`role changed to ${role} for membership ${membershipId}`);
    return toTenantUserDto(updated);
  }

  /** Update the display name of a staff account without changing its email or role. */
  async updateStaff(membershipId: string, request: UpdateStaffRequest): Promise<TenantUserDto> {
    const fullName = request.fullName?.trim();
    if (!fullName) throw new ValidationFailedException('A staff member needs a name');

    const membership = await this.prisma.tenantUser.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });
    if (!membership || membership.role !== Role.STAFF) {
      throw new NotFoundException('Staff member', membershipId);
    }

    // User identity is global. A tenant Manager must not rename an identity that is
    // also active in another tenant, because that would be a cross-tenant mutation.
    const memberships = await this.tenantContext.runAsSystem(
      'check whether a staff identity is shared before editing it',
      async () =>
        await this.prisma.tenantUser.count({
          where: { userId: membership.userId },
        }),
    );
    if (memberships > 1) {
      throw new ValidationFailedException(
        'This account belongs to multiple workspaces; its global profile name cannot be edited here',
      );
    }

    const updatedUser = await this.tenantContext.runAsSystem(
      'update a single-workspace staff profile name',
      async () => await this.prisma.user.update({ where: { id: membership.userId }, data: { fullName } }),
    );

    return toTenantUserDto({ ...membership, user: updatedUser });
  }

  /** Reactivate a retained staff membership. Deactivation continues to use revoke(). */
  async reactivate(membershipId: string): Promise<TenantUserDto> {
    const membership = await this.prisma.tenantUser.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });
    if (!membership || membership.role !== Role.STAFF) {
      throw new NotFoundException('Staff member', membershipId);
    }

    if (membership.inviteStatus !== InviteStatus.REVOKED) return toTenantUserDto(membership);

    const restored = await this.prisma.tenantUser.update({
      where: { id: membershipId },
      data: {
        inviteStatus: InviteStatus.ACTIVE,
        revokedAt: null,
        acceptedAt: membership.acceptedAt ?? new Date(),
      },
      include: { user: true },
    });
    this.logger.log(`reactivated ${membership.user.email} on tenant ${membership.tenantId}`);
    return toTenantUserDto(restored);
  }

  /**
   * Recent staff-attributable activity from existing authoritative resource rows.
   * Contacts have no actor column, so they are deliberately omitted rather than
   * guessed. Revoked staff remain included because their membership row is retained.
   */
  async activity(): Promise<TeamActivityDto[]> {
    const members = await this.prisma.tenantUser.findMany({
      where: { role: Role.STAFF },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    const names = new Map(members.map((member) => [member.userId, member.user.fullName]));
    const staffUserIds = [...names.keys()];
    if (staffUserIds.length === 0) return [];

    const [campaigns, templates, calls] = await Promise.all([
      this.prisma.campaign.findMany({
        where: { createdBy: { in: staffUserIds } },
        select: { id: true, name: true, status: true, createdBy: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.template.findMany({
        where: { createdBy: { in: staffUserIds } },
        select: { id: true, name: true, status: true, createdBy: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.call.findMany({
        where: { createdBy: { in: staffUserIds } },
        select: {
          id: true,
          status: true,
          createdBy: true,
          createdAt: true,
          contact: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return [
      ...campaigns.map((campaign) => ({
        id: `campaign:${campaign.id}`,
        staffUserId: campaign.createdBy,
        staffName: names.get(campaign.createdBy) ?? 'Former staff member',
        type: 'campaign_created' as const,
        action: 'Created campaign',
        resourceType: 'campaign' as const,
        resourceId: campaign.id,
        resourceName: campaign.name,
        status: campaign.status,
        occurredAt: campaign.createdAt.toISOString(),
      })),
      ...templates.flatMap((template) => {
        if (!template.createdBy) return [];
        return [{
          id: `template:${template.id}`,
          staffUserId: template.createdBy,
          staffName: names.get(template.createdBy) ?? 'Former staff member',
          type: 'template_created' as const,
          action: 'Created template',
          resourceType: 'template' as const,
          resourceId: template.id,
          resourceName: template.name,
          status: template.status,
          occurredAt: template.createdAt.toISOString(),
        }];
      }),
      ...calls.flatMap((call) => {
        if (!call.createdBy) return [];
        return [{
          id: `call:${call.id}`,
          staffUserId: call.createdBy,
          staffName: names.get(call.createdBy) ?? 'Former staff member',
          type: 'call_triggered' as const,
          action: 'Triggered call',
          resourceType: 'call' as const,
          resourceId: call.id,
          resourceName: call.contact.fullName,
          status: call.status,
          occurredAt: call.createdAt.toISOString(),
        }];
      }),
    ]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 50);
  }

  /**
   * Initiate a secure password reset flow for a colleague.
   *
   * Security hardening (Sprint 0B): A tenant administrator may NEVER reset or receive
   * a global user's plaintext password. One User may belong to multiple tenants; granting
   * a tenant manager the power to reset and receive credentials would allow cross-tenant
   * account takeover. Instead, this initiates a secure, time-limited reset token.
   */
  async resetPassword(membershipId: string, actorRole: Role = Role.MANAGER): Promise<{ ok: true; email: string; message: string }> {
    const membership = await this.prisma.tenantUser.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('Tenant member', membershipId);
    if (actorRole === Role.MANAGER && membership.role !== Role.STAFF) {
      throw new ValidationFailedException('Managers can reset passwords for Staff accounts only');
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.tenantContext.runAsSystem('create password reset token for tenant member', async () => {
      await this.prisma.passwordResetToken.create({
        data: {
          userId: membership.userId,
          tokenHash,
          expiresAt,
        },
      });
    });

    this.logger.log(`password reset initiated for ${membership.user.email} by tenant manager`);
    return {
      ok: true,
      email: membership.user.email,
      message: 'Password reset instructions have been initiated for this user',
    };
  }
}

function toTenantUserDto(row: {
  id: string;
  userId: string;
  role: string;
  inviteStatus: string;
  createdAt: Date;
  user: { email: string; fullName: string; lastLoginAt: Date | null };
}): TenantUserDto {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    fullName: row.user.fullName,
    role: row.role as Role,
    inviteStatus: row.inviteStatus as InviteStatus,
    lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const body = Array.from(randomBytes(16), (byte) => alphabet[byte % alphabet.length]).join('');
  return `Ak${body}7`;
}
