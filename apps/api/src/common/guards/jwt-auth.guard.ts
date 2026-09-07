import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { RequestPrincipal } from '../auth/jwt-payload';
import { PUBLIC_KEY, WEBHOOK_KEY } from '../decorators';
import { UnauthorizedException } from '../errors/app-exception';
import { PRISMA, type ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * Requires an authenticated principal, unless the route is explicitly marked
 * `@Public(reason)` or `@Webhook(provider)`.
 *
 * Registered globally as the first guard in the APP_GUARD pipeline:
 * JwtAuthGuard → TenantGuard → RolesGuard → Controller.
 *
 * In addition to verifying the token presence, it actively checks:
 * 1. User exists in the database
 * 2. User account is active (`user.isActive === true`)
 * 3. Session (if sid is present) exists, has not expired, and has not been revoked.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    const isPublic = this.reflector.getAllAndOverride<string>(PUBLIC_KEY, [handler, controller]);
    if (isPublic) return true;

    // Webhooks authenticate by provider signature inside the handler (spec §12),
    // not by user JWT. The signature check is mandatory and enforced by the provider handler.
    const isWebhook = this.reflector.getAllAndOverride<string>(WEBHOOK_KEY, [handler, controller]);
    if (isWebhook) return true;

    const request = context.switchToHttp().getRequest<Request & { principal?: RequestPrincipal; authError?: string }>();
    if (!request.principal) {
      throw new UnauthorizedException(request.authError ?? 'Authentication is required');
    }

    const { userId, sessionId } = request.principal;

    // Active user check
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User account is inactive or no longer exists');
    }

    // Active session check (if sid is attached to the JWT)
    if (sessionId) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { id: true, expiresAt: true, revokedAt: true },
      });

      if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
        throw new UnauthorizedException('Session has been revoked or expired');
      }
    }

    return true;
  }
}
