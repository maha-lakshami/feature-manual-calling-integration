import { Inject, Injectable } from '@nestjs/common';
import {
  Channel,
  type TemplateAutopilotGenerateRequest,
  type TemplateAutopilotResult,
} from '@aiking/shared';

import { ValidationFailedException } from '../../common/errors/app-exception';
import { LLM_PROVIDER, type LlmProvider } from '../../providers/provider.types';
import { extractVariables } from './templates.service';
import { TemplatesService } from './templates.service';

const MAX_PROMPT_LENGTH = 4_000;
const MAX_BODY_LENGTH = 20_000;

@Injectable()
export class TemplateAutopilotService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly templates: TemplatesService,
  ) {}

  async generate(request: TemplateAutopilotGenerateRequest): Promise<TemplateAutopilotResult> {
    const input = this.validateGenerationRequest(request);
    return this.validateResult(await this.llm.generateTemplate(input), input.channel);
  }

  async modify(templateId: string, instructionValue: unknown): Promise<TemplateAutopilotResult> {
    const instruction = this.requiredText(instructionValue, 'A modification instruction is required', MAX_PROMPT_LENGTH);
    const current = await this.templates.get(templateId);
    const currentResult: TemplateAutopilotResult = {
      name: current.name,
      channel: current.channel,
      subject: current.subject,
      body: current.body,
      variables: current.variables,
    };
    const result = this.validateResult(
      await this.llm.modifyTemplate({ instruction, current: currentResult }),
      current.channel,
    );
    const lostVariables = current.variables.filter((variable) => !result.variables.includes(variable));
    if (lostVariables.length > 0) {
      throw new ValidationFailedException('AI revision removed existing template variables', { lostVariables });
    }
    return result;
  }

  private validateGenerationRequest(value: TemplateAutopilotGenerateRequest): TemplateAutopilotGenerateRequest {
    if (!value || (value.channel !== Channel.WHATSAPP && value.channel !== Channel.EMAIL)) {
      throw new ValidationFailedException('Autopilot channel must be whatsapp or email');
    }
    return {
      channel: value.channel,
      prompt: this.requiredText(value.prompt, 'An Autopilot prompt is required', MAX_PROMPT_LENGTH),
      tone: this.optionalText(value.tone, 100),
      language: this.optionalText(value.language, 100),
      targetAudience: this.optionalText(value.targetAudience, 200),
    };
  }

  private validateResult(value: unknown, expectedChannel: Channel): TemplateAutopilotResult {
    if (!value || typeof value !== 'object') throw new ValidationFailedException('AI returned a malformed template');
    const candidate = value as Partial<TemplateAutopilotResult>;
    if (candidate.channel !== expectedChannel) throw new ValidationFailedException('AI returned the wrong template channel');
    const name = this.requiredText(candidate.name, 'AI returned a template without a name', 120);
    const body = this.requiredText(candidate.body, 'AI returned a template without content', MAX_BODY_LENGTH);
    if (expectedChannel === Channel.WHATSAPP && /<\/?[a-z][^>]*>/i.test(body)) {
      throw new ValidationFailedException('AI returned unsupported HTML for WhatsApp');
    }
    const subject = candidate.subject == null ? null : this.optionalText(candidate.subject, 300) ?? null;
    if (expectedChannel === Channel.EMAIL && !subject) {
      throw new ValidationFailedException('AI returned an email template without a subject');
    }
    return {
      name,
      channel: expectedChannel,
      subject: expectedChannel === Channel.EMAIL ? subject : null,
      body,
      variables: extractVariables(body, subject),
      category: this.optionalText(candidate.category, 80),
      notes: this.optionalText(candidate.notes, 500),
    };
  }

  private requiredText(value: unknown, message: string, max: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new ValidationFailedException(message);
    return this.clean(value, max);
  }

  private optionalText(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return this.clean(value, max);
  }

  private clean(value: string, max: number): string {
    const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    if (clean.length > max) throw new ValidationFailedException(`Text exceeds the ${max} character limit`);
    return clean;
  }
}
