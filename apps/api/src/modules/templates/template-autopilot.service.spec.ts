import { Channel, Permission, TemplateStatus, type TemplateDto } from '@aiking/shared';

import { PERMISSION_KEY } from '../../common/decorators';
import { NotFoundException } from '../../common/errors/app-exception';
import { LlmMockProvider } from '../../providers/llm/llm.mock';
import { TemplatesController } from './templates.controller';
import { TemplateAutopilotService } from './template-autopilot.service';

const current: TemplateDto = {
  id: '11111111-1111-1111-1111-111111111111', name: 'Diwali offer', channel: Channel.WHATSAPP,
  status: TemplateStatus.APPROVED, language: 'en', subject: null,
  body: 'Hi {{customer_name}}, save 15% before {{expiry_date}}.', variables: ['customer_name', 'expiry_date'],
  providerTemplateName: 'diwali_offer', submittedAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
  rejectionReason: null, createdAt: new Date().toISOString(),
};

describe('TemplateAutopilotService', () => {
  const behavior = { begin: jest.fn().mockResolvedValue(undefined) };

  it('generates a deterministic structured WhatsApp draft through the mock LLM', async () => {
    const llm = new LlmMockProvider(behavior as any);
    const templates = { get: jest.fn() };
    const service = new TemplateAutopilotService(llm, templates as any);
    const result = await service.generate({ channel: Channel.WHATSAPP, prompt: 'Create a Diwali offer with 15% discount' });
    expect(result).toMatchObject({ channel: Channel.WHATSAPP, subject: null, variables: ['customer_name', 'expiry_date'] });
    expect(result.body).toContain('15%');
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('providerTemplateName');
    expect(templates.get).not.toHaveBeenCalled();
  });

  it('requires a subject for generated Email content', async () => {
    const service = new TemplateAutopilotService(new LlmMockProvider(behavior as any), { get: jest.fn() } as any);
    const result = await service.generate({ channel: Channel.EMAIL, prompt: 'Create a service reminder' });
    expect(result.subject).toBeTruthy();
    expect(result.channel).toBe(Channel.EMAIL);
  });

  it('rejects malformed or wrong-channel model output', async () => {
    const llm = { generateTemplate: jest.fn().mockResolvedValue({ name: '', channel: Channel.EMAIL, body: '' }) };
    const service = new TemplateAutopilotService(llm as any, { get: jest.fn() } as any);
    await expect(service.generate({ channel: Channel.WHATSAPP, prompt: 'Create a notice' })).rejects.toThrow('wrong template channel');
  });

  it('loads modification source through tenant-scoped TemplatesService and returns preview only', async () => {
    const llm = { modifyTemplate: jest.fn().mockResolvedValue({ ...current, status: TemplateStatus.APPROVED, body: `${current.body} Act now.` }) };
    const templates = { get: jest.fn().mockResolvedValue(current), update: jest.fn() };
    const service = new TemplateAutopilotService(llm as any, templates as any);
    const result = await service.modify(current.id, 'Add urgency while preserving variables');
    expect(templates.get).toHaveBeenCalledWith(current.id);
    expect(templates.update).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('status');
    expect(result.variables).toEqual(current.variables);
  });

  it('rejects a revision that removes an existing variable', async () => {
    const llm = { modifyTemplate: jest.fn().mockResolvedValue({ ...current, body: 'A generic offer.' }) };
    const service = new TemplateAutopilotService(llm as any, { get: jest.fn().mockResolvedValue(current) } as any);
    await expect(service.modify(current.id, 'Make it shorter')).rejects.toThrow('removed existing template variables');
  });

  it('preserves tenant isolation when the source template is not visible', async () => {
    const llm = { modifyTemplate: jest.fn() };
    const service = new TemplateAutopilotService(llm as any, { get: jest.fn().mockRejectedValue(new NotFoundException('Template', current.id)) } as any);
    await expect(service.modify(current.id, 'Change it')).rejects.toThrow('Template');
    expect(llm.modifyTemplate).not.toHaveBeenCalled();
  });

  it('protects both Autopilot endpoints with the template-management permission', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, TemplatesController.prototype.generateWithAutopilot)).toBe(Permission.TEMPLATES_MANAGE);
    expect(Reflect.getMetadata(PERMISSION_KEY, TemplatesController.prototype.modifyWithAutopilot)).toBe(Permission.TEMPLATES_MANAGE);
  });
});
