import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppConfigModule } from './config/config.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { ProvidersModule } from './providers/providers.module';

import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { CallsModule } from './modules/calls/calls.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { CommunicationsModule } from './modules/communications/communications.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { HealthModule } from './modules/health/health.module';
import { QueueModule } from './modules/queue/queue.module';
import { RazorpayModule } from './modules/razorpay/razorpay.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { RateCatalogModule } from './modules/rate-catalog/rate-catalog.module';

/**
 * Root application module — spec §3.5 modular monolith.
 *
 * Both the API process (`main.ts`) and the worker process (`worker.ts`) boot
 * the same `AppModule`. Whether an HTTP server actually listens, and whether
 * BullMQ workers actually poll, is determined by `APP_ROLE` — see
 * `QueueService.onApplicationBootstrap()` and `main.ts`.
 *
 * Global Security Pipeline:
 *   1. TenantContextMiddleware (extracts JWT, prepares AsyncLocalStorage scope)
 *   2. JwtAuthGuard (APP_GUARD: authentication & session verification)
 *   3. TenantGuard (APP_GUARD: cross-tenant isolation & active membership check)
 *   4. RolesGuard (APP_GUARD: fine-grained role & permission matrix check)
 */
@Module({
  imports: [
    // ── Global infrastructure ────────────────────────────────────────────────
    AppConfigModule,
    CommonModule,
    ProvidersModule,
    QueueModule,

    // ── Domain modules ───────────────────────────────────────────────────────
    HealthModule,
    AuthModule,
    UsersModule,
    ContactsModule,
    TemplatesModule,
    WalletModule,
    BillingModule,
    RazorpayModule,
    CommunicationsModule,
    CampaignsModule,
    CallsModule,
    TenantsModule,
    WebhooksModule,
    RateCatalogModule,
  ],
  providers: [
    // Global exception filter — every uncaught error is standardised into the
    // spec's error envelope before it reaches the client.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // BigInt paise values need serialisation to JSON-safe strings.
    { provide: APP_INTERCEPTOR, useClass: BigIntSerializerInterceptor },
    // Global guard chain: Authentication → Tenant Isolation → Authorization
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  /**
   * Middleware is applied to *all* routes. The tenant context middleware
   * verifies the JWT (if present) and opens an `AsyncLocalStorage` scope that
   * every downstream guard, interceptor, and service observes. Routes that
   * need no authentication (`@Public`, `@Webhook`) are still wrapped — the
   * middleware simply records "no principal" and moves on, letting the guards
   * decide whether that is allowed.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
