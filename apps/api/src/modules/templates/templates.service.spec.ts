import { Channel, TemplateStatus } from '@aiking/shared';

import { TemplatesService } from './templates.service';

const tenantId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';
const templateId = '33333333-3333-3333-3333-333333333333';
const now = new Date('2026-09-06T00:00:00.000Z');

const templateRow = (overrides: Record<string, unknown> = {}) => ({
  id: templateId,
  tenantId,
  name: 'Diwali Fleet Service Offer',
  channel: Channel.WHATSAPP,
  status: TemplateStatus.DRAFT,
  language: 'en',
  subject: null,
  body: 'Hello {{fullName}}, save 15% before {{expiryDate}}.',
  variables: ['fullName', 'expiryDate'],
  providerTemplateName: null,
  submittedAt: null,
  approvedAt: null,
  rejectionReason: null,
  createdBy: userId,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

describe('TemplatesService lifecycle', () => {
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(tenantId) };

  it('creates an AI-selected WhatsApp template as an unlinked draft', async () => {
    const create = jest.fn().mockImplementation(({ data }) => Promise.resolve(templateRow(data)));
    const service = new TemplatesService({ template: { create } } as any, tenantContext as any);

    const result = await service.create(
      {
        name: 'Diwali Fleet Service Offer',
        channel: Channel.WHATSAPP,
        body: 'Hello {{fullName}}, save 15% before {{expiryDate}}.',
      },
      userId,
    );

    expect(result).toMatchObject({
      status: TemplateStatus.DRAFT,
      providerTemplateName: null,
      submittedAt: null,
      approvedAt: null,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        status: TemplateStatus.DRAFT,
        variables: ['fullName', 'expiryDate'],
      }),
    });
  });

  it('provider-links and mock-approves WhatsApp only after explicit submit', async () => {
    const draft = templateRow();
    const approved = templateRow({
      status: TemplateStatus.APPROVED,
      providerTemplateName: 'diwali_fleet_service_offer',
      submittedAt: now,
      approvedAt: now,
    });
    const findUnique = jest.fn().mockResolvedValue(draft);
    const update = jest.fn().mockResolvedValue(approved);
    const service = new TemplatesService({ template: { findUnique, update } } as any, tenantContext as any);

    const result = await service.submit(templateId, true);

    expect(update).toHaveBeenCalledWith({
      where: { id: templateId },
      data: expect.objectContaining({
        status: TemplateStatus.APPROVED,
        providerTemplateName: 'diwali_fleet_service_offer',
      }),
    });
    expect(result.status).toBe(TemplateStatus.APPROVED);
  });

  it('supports Email subject/body variables and allows an unpaused draft to launch', async () => {
    const emailDraft = templateRow({
      channel: Channel.EMAIL,
      name: 'Service reminder',
      subject: 'Reminder for {{fullName}}',
      body: 'Your service is due on {{serviceDate}}.',
      variables: ['serviceDate', 'fullName'],
    });
    const create = jest.fn().mockImplementation(({ data }) => Promise.resolve(templateRow(data)));
    const findUnique = jest.fn().mockResolvedValue(emailDraft);
    const service = new TemplatesService({ template: { create, findUnique } } as any, tenantContext as any);

    const created = await service.create(
      {
        name: 'Service reminder',
        channel: Channel.EMAIL,
        subject: 'Reminder for {{fullName}}',
        body: 'Your service is due on {{serviceDate}}.',
      },
      userId,
    );
    const launchable = await service.assertLaunchable(templateId, Channel.EMAIL);

    expect(created).toMatchObject({
      channel: Channel.EMAIL,
      status: TemplateStatus.DRAFT,
      subject: 'Reminder for {{fullName}}',
      variables: ['serviceDate', 'fullName'],
    });
    expect(launchable).toBe(emailDraft);
  });

  it('keeps a WhatsApp draft ineligible until approval', async () => {
    const findUnique = jest.fn().mockResolvedValue(templateRow());
    const service = new TemplatesService({ template: { findUnique } } as any, tenantContext as any);

    await expect(service.assertLaunchable(templateId, Channel.WHATSAPP)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_APPROVED',
    });
  });

  it('deletes only an unused draft template', async () => {
    const findUnique = jest.fn().mockResolvedValue(templateRow());
    const count = jest.fn().mockResolvedValue(0);
    const remove = jest.fn().mockResolvedValue(templateRow());
    const service = new TemplatesService(
      { template: { findUnique, delete: remove }, campaign: { count } } as any,
      tenantContext as any,
    );

    await service.remove(templateId);

    expect(count).toHaveBeenCalledWith({ where: { templateId } });
    expect(remove).toHaveBeenCalledWith({ where: { id: templateId } });
  });

  it.each([
    [TemplateStatus.APPROVED, { submittedAt: now, approvedAt: now, providerTemplateName: 'linked_template' }],
    [TemplateStatus.PENDING_APPROVAL, { submittedAt: now, providerTemplateName: 'linked_template' }],
    [TemplateStatus.PAUSED, { submittedAt: now }],
  ])('preserves %s template history instead of deleting it', async (status, lifecycle) => {
    const remove = jest.fn();
    const service = new TemplatesService(
      {
        template: { findUnique: jest.fn().mockResolvedValue(templateRow({ status, ...lifecycle })), delete: remove },
        campaign: { count: jest.fn() },
      } as any,
      tenantContext as any,
    );

    await expect(service.remove(templateId)).rejects.toMatchObject({ status: 409 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('preserves a draft referenced by campaign history', async () => {
    const remove = jest.fn();
    const service = new TemplatesService(
      {
        template: { findUnique: jest.fn().mockResolvedValue(templateRow()), delete: remove },
        campaign: { count: jest.fn().mockResolvedValue(1) },
      } as any,
      tenantContext as any,
    );

    await expect(service.remove(templateId)).rejects.toMatchObject({ status: 409 });
    expect(remove).not.toHaveBeenCalled();
  });
});
