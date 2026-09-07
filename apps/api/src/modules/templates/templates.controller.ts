import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Channel,
  Permission,
  TemplateStatus,
  type CreateTemplateRequest,
  type TemplateAutopilotGenerateRequest,
  type TemplateAutopilotModifyRequest,
  type TemplateAutopilotResult,
  type TemplateDto,
} from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { TemplatesService } from './templates.service';
import { TemplateAutopilotService } from './template-autopilot.service';

/**
 * Message templates — spec §6.1.
 *
 * Template reads and management actions use the dedicated `templates:manage`
 * permission. Campaign launch authority remains separate.
 */
@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly autopilot: TemplateAutopilotService,
    private readonly tenantAccess: TenantAccessService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('autopilot/generate')
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'Generate a validated template draft preview with the configured LLM provider' })
  async generateWithAutopilot(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: TemplateAutopilotGenerateRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<TemplateAutopilotResult> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'generate a template draft with AI', () =>
      this.autopilot.generate(body),
    );
  }

  @Post(':templateId/autopilot/modify')
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'Generate a validated revision preview without updating the template' })
  async modifyWithAutopilot(
    @CurrentUser() principal: RequestPrincipal,
    @Param('templateId') templateId: string,
    @Body() body: TemplateAutopilotModifyRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<TemplateAutopilotResult> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'modify a template draft with AI', () =>
      this.autopilot.modify(templateId, body?.instruction),
    );
  }

  @Get()
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'List templates' })
  async list(
    @CurrentUser() principal: RequestPrincipal,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<TemplateDto[]> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'list templates', () =>
      this.templates.list({ channel: parseChannel(channel), status: parseStatus(status) }),
    );
  }

  @Post()
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'Create a template (starts as draft)' })
  async create(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: CreateTemplateRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<TemplateDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'create a template', () =>
      this.templates.create(body, principal.userId),
    );
  }

  @Get(':templateId')
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'One template' })
  async get(
    @CurrentUser() principal: RequestPrincipal,
    @Param('templateId') templateId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<TemplateDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'read a template', () =>
      this.templates.get(templateId),
    );
  }

  @Patch(':templateId')
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'Edit a template — editing approved WhatsApp content resets it to draft' })
  async update(
    @CurrentUser() principal: RequestPrincipal,
    @Param('templateId') templateId: string,
    @Body() body: Partial<CreateTemplateRequest>,
    @Query('tenantId') tenantId?: string,
  ): Promise<TemplateDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'edit a template', () =>
      this.templates.update(templateId, body),
    );
  }

  /**
   * Submit for provider approval — spec §6.1.
   *
   * Whether approval is instant is a property of the deployment, not of the request: in
   * mock mode there is no Meta to ask, so the template is approved on the spot and the
   * campaign pipeline is testable. In live mode it waits for the real callback.
   */
  @Post(':templateId/submit')
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'Submit for provider approval (auto-approved in mock mode)' })
  async submit(
    @CurrentUser() principal: RequestPrincipal,
    @Param('templateId') templateId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<TemplateDto> {
    const autoApprove = this.config.providers.whatsapp === 'mock';
    return this.tenantAccess.asCaller(
      principal,
      tenantId ?? principal.tenantId ?? undefined,
      'submit a template for approval',
      () => this.templates.submit(templateId, autoApprove),
    );
  }

  @Post(':templateId/pause')
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'Pause a template so no new campaign can use it' })
  async pause(
    @CurrentUser() principal: RequestPrincipal,
    @Param('templateId') templateId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<TemplateDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'pause a template', () =>
      this.templates.pause(templateId),
    );
  }

  @Delete(':templateId')
  @HttpCode(204)
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  @ApiOperation({ summary: 'Delete an unused draft template; submitted or used templates must be paused' })
  async remove(
    @CurrentUser() principal: RequestPrincipal,
    @Param('templateId') templateId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<void> {
    await this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'delete a template', () =>
      this.templates.remove(templateId),
    );
  }
}

function parseChannel(value?: string): Channel | undefined {
  if (!value) return undefined;
  const known = Object.values(Channel) as string[];
  if (!known.includes(value)) {
    throw new ValidationFailedException(`Unknown channel "${value}"`, { allowed: known });
  }
  return value as Channel;
}

function parseStatus(value?: string): TemplateStatus | undefined {
  if (!value) return undefined;
  const known = Object.values(TemplateStatus) as string[];
  if (!known.includes(value)) {
    throw new ValidationFailedException(`Unknown template status "${value}"`, { allowed: known });
  }
  return value as TemplateStatus;
}
