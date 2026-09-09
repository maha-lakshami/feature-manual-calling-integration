import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, type AuthenticatedUser, type LoginRequest, type LoginResponse } from '@aiking/shared';
import type { Request, Response } from 'express';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { UnauthorizedException, ValidationFailedException } from '../../common/errors/app-exception';
import { AuthService } from './auth.service';

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

interface ResetPasswordBody {
  token?: string;
  newPassword?: string;
}

/** HTTP-only session cookie storing the high-entropy refresh token. */
export const SESSION_COOKIE = 'aiking_session';
/** Legacy token cookie name for migration and cleanup. */
export const TOKEN_COOKIE = 'aiking_token';

/**
 * Auth endpoints — spec §4.1.
 *
 * Coherent auth architecture:
 * - Access token is short-lived, returned in body, stored in memory only.
 * - Refresh token is stored in an HTTP-only Secure cookie (`aiking_session`).
 * - Sessions are tracked in the database and fully revocable.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public('credentials are the authentication')
  @ApiOperation({ summary: 'Exchange credentials for an access token and session cookie (spec §4.1)' })
  async login(
    @Body() body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(body, {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    response.cookie(SESSION_COOKIE, result.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Clear legacy cookie if present
    response.clearCookie(TOKEN_COOKIE, { path: '/' });

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  @Post('refresh')
  @Public('session cookie or refresh token is the credential')
  @ApiOperation({ summary: 'Rotate refresh token and issue a fresh access token' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body?: { refreshToken?: string },
  ): Promise<LoginResponse> {
    const cookieToken = extractCookie(request, SESSION_COOKIE);
    const refreshToken = body?.refreshToken || cookieToken;

    if (!refreshToken) {
      throw new UnauthorizedException('No active session or refresh token found');
    }

    const result = await this.auth.refresh(refreshToken, {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    response.cookie(SESSION_COOKIE, result.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  /** Clears the session cookie and marks the session revoked in the database. */
  @Post('logout')
  @Public('clearing a cookie needs no authorization')
  @ApiOperation({ summary: 'Revoke server session and clear session cookies' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body?: { refreshToken?: string },
  ): Promise<{ ok: true }> {
    const cookieToken = extractCookie(request, SESSION_COOKIE);
    const token = body?.refreshToken || cookieToken || (request as any).principal?.sessionId;

    if (token) {
      await this.auth.logout(token);
    }

    response.clearCookie(SESSION_COOKIE, { path: '/' });
    response.clearCookie(TOKEN_COOKIE, { path: '/' });
    return { ok: true };
  }

  /**
   * The caller's identity with permissions **re-resolved from the current tenant
   * policy**, not from the token. That is what makes a §4.4 policy change take effect
   * in the UI within one page load.
   */
  @Get('me')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER, Role.STAFF)
  @ApiOperation({ summary: 'Current user, with freshly resolved permissions' })
  async me(@CurrentUser() principal: RequestPrincipal): Promise<AuthenticatedUser> {
    return this.auth.describe(principal);
  }

  /** Tenants this account can open a session against, for a tenant switcher. */
  @Get('memberships')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER, Role.STAFF)
  @ApiOperation({ summary: 'Tenants this account belongs to' })
  async memberships(@CurrentUser() principal: RequestPrincipal) {
    return this.auth.memberships(principal.userId);
  }

  @Post('password')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER, Role.STAFF)
  @ApiOperation({ summary: 'Change your own password' })
  async changePassword(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: ChangePasswordBody,
  ): Promise<{ ok: true }> {
    if (!body.currentPassword || !body.newPassword) {
      throw new ValidationFailedException('currentPassword and newPassword are both required');
    }
    await this.auth.changePassword(principal.userId, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Post('reset-password')
  @Public('reset token verifies identity')
  @ApiOperation({ summary: 'Complete a password reset with a valid token' })
  async resetPassword(@Body() body: ResetPasswordBody): Promise<{ ok: true }> {
    if (!body.token || !body.newPassword) {
      throw new ValidationFailedException('token and newPassword are both required');
    }
    await this.auth.resetPasswordWithToken(body.token, body.newPassword);
    return { ok: true };
  }
}

function extractCookie(req: Request, cookieName: string): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) return decodeURIComponent(rest.join('=')) || null;
  }
  return null;
}
