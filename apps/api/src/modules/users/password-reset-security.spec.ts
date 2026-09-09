import { Test, TestingModule } from '@nestjs/testing';
import { InviteStatus, Role } from '@aiking/shared';

import { PRISMA } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';

describe('Password Reset Security (Cross-Tenant Account Takeover Prevention)', () => {
  let usersService: UsersService;
  let mockPrisma: any;
  let mockAuth: any;
  let tenantContext: TenantContext;

  const tenantAId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const tenantBId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const targetUserId = 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu';
  const membershipAId = 'mem-a-123';

  beforeEach(async () => {
    tenantContext = new TenantContext();

    mockPrisma = {
      tenantUser: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      passwordResetToken: {
        create: jest.fn().mockResolvedValue({ id: 'token-1' }),
      },
    };

    mockAuth = {
      hashPassword: jest.fn().mockResolvedValue('new-hash'),
      revokeTenantMembershipSessions: jest.fn().mockResolvedValue(undefined),
      revokeUserSessions: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PRISMA, useValue: mockPrisma },
        { provide: AuthService, useValue: mockAuth },
        { provide: TenantContext, useValue: tenantContext },
      ],
    }).compile();

    usersService = module.get<UsersService>(UsersService);
  });

  it('prohibits Tenant A manager from receiving credentials for a user who also belongs to Tenant B', async () => {
    const existingPasswordHash = '$2a$10$originalPasswordHashForTenantB';

    // Target user belongs to Tenant A AND Tenant B
    mockPrisma.tenantUser.findUnique.mockResolvedValue({
      id: membershipAId,
      tenantId: tenantAId,
      userId: targetUserId,
      role: Role.STAFF,
      inviteStatus: InviteStatus.ACTIVE,
      user: {
        id: targetUserId,
        email: 'shared-user@example.com',
        fullName: 'Shared User',
        passwordHash: existingPasswordHash,
        tenantUsers: [
          { tenantId: tenantAId, role: Role.STAFF },
          { tenantId: tenantBId, role: Role.MANAGER },
        ],
      },
    });

    // Tenant A manager initiates password reset
    const result = await usersService.resetPassword(membershipAId);

    // 1. Result must NEVER disclose a plaintext password or token to Tenant A manager
    expect(result).not.toHaveProperty('temporaryPassword');
    expect((result as any).password).toBeUndefined();
    expect((result as any).token).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.email).toBe('shared-user@example.com');

    // 2. Global user passwordHash MUST NOT be modified by Tenant A manager
    expect(mockPrisma.user.update).not.toHaveBeenCalled();

    // 3. A single-use reset token was created for the user to complete verification
    expect(mockPrisma.passwordResetToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: targetUserId,
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      }),
    );
  });
});
