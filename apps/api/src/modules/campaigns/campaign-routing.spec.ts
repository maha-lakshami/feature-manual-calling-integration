import { CampaignStatus, Channel, RecipientStatus } from '@aiking/shared';

import { NotFoundException } from '../../common/errors/app-exception';
import { TenantContext } from '../../common/tenant/tenant-context';
import { MockProviderError } from '../../providers/mock-support';
import { CampaignProcessors } from './campaign.processors';
import { CampaignsService } from './campaigns.service';

describe('Campaign channel routing and execution safety', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';

  function processorFixture(
    channel: string,
    contactOverrides: Record<string, unknown> = {},
    emailShadowRating?: Record<string, jest.Mock>,
  ) {
    const recipient = {
      id: 'recipient-1',
      tenantId: tenantA,
      campaignId: 'campaign-1',
      contactId: 'contact-1',
      destination: channel === Channel.EMAIL ? 'alice@example.com' : '+919876543210',
      status: RecipientStatus.QUEUED,
      contact: {
        id: 'contact-1',
        tenantId: tenantA,
        fullName: 'Alice',
        phone: '+919876543210',
        email: 'alice@example.com',
        customFields: {},
        tags: [],
        optedOutAt: null,
        deletedAt: null,
        whatsappOptedIn: true,
        emailOptedIn: true,
        ...contactOverrides,
      },
      campaign: {
        id: 'campaign-1',
        tenantId: tenantA,
        name: 'Safety campaign',
        channel,
        status: CampaignStatus.SENDING as CampaignStatus,
        variables: {},
        template: {
          id: 'template-1',
          tenantId: tenantA,
          name: 'Update',
          providerTemplateName: 'shipment_update',
          language: 'en',
          variables: [],
          subject: 'Shipment update',
          body: '<p>Your shipment is ready.</p>',
        },
        tenant: { whatsappPhoneNumberId: 'phone-number-1', emailFromName: 'AiConnect', emailFromAddress: null },
      },
    };
    const prisma = {
      campaign: {
        findUnique: jest.fn().mockResolvedValue(recipient.campaign),
        update: jest.fn().mockResolvedValue(undefined),
      },
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue([{ id: recipient.id }]),
        findUnique: jest.fn().mockResolvedValue(recipient),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const whatsapp = {
      sendTemplate: jest.fn().mockResolvedValue({
        providerMessageId: 'wamid-1',
        acceptedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    };
    const email = {
      providerId: 'mock-email',
      send: jest.fn().mockResolvedValue({
        providerMessageId: 'email-1',
        acceptedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    };
    const queue = { register: jest.fn(), enqueue: jest.fn().mockResolvedValue(undefined) };
    const metering = {
      reserve: jest.fn().mockResolvedValue({ created: true, heldPaise: 100n }),
      settle: jest.fn().mockResolvedValue({ totalChargePaise: 100n }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const wallet = {};
    const campaigns = { finalizeIfDone: jest.fn().mockResolvedValue(undefined) };
    const communications = { recordSafely: jest.fn().mockResolvedValue(undefined) };
    const tenantContext = new TenantContext();
    const processor = new CampaignProcessors(
      prisma as any,
      { email: { from: 'noreply@example.com' } } as any,
      whatsapp as any,
      email as any,
      queue as any,
      metering as any,
      wallet as any,
      campaigns as any,
      communications as any,
      tenantContext,
      undefined,
      emailShadowRating as any,
    );
    return { processor, prisma, whatsapp, email, queue, metering, campaigns, recipient, tenantContext };
  }

  it('routes WHATSAPP only to whatsapp-send', async () => {
    const fixture = processorFixture(Channel.WHATSAPP);
    await (fixture.processor as any).dispatch({ tenantId: tenantA, campaignId: 'campaign-1' });
    expect(fixture.queue.enqueue).toHaveBeenCalledWith(
      'whatsapp-send',
      expect.objectContaining({ campaignRecipientId: 'recipient-1' }),
      { jobId: 'send:recipient-1' },
    );
    expect(fixture.queue.enqueue).not.toHaveBeenCalledWith('email-send', expect.anything(), expect.anything());
  });

  it('routes EMAIL only to email-send', async () => {
    const fixture = processorFixture(Channel.EMAIL);
    await (fixture.processor as any).dispatch({ tenantId: tenantA, campaignId: 'campaign-1' });
    expect(fixture.queue.enqueue).toHaveBeenCalledWith(
      'email-send',
      expect.objectContaining({ campaignRecipientId: 'recipient-1' }),
      { jobId: 'send:recipient-1' },
    );
    expect(fixture.queue.enqueue).not.toHaveBeenCalledWith('whatsapp-send', expect.anything(), expect.anything());
  });

  it.each([Channel.CALL, 'unknown'])('fails %s dispatch before state mutation or enqueue', async (channel) => {
    const fixture = processorFixture(channel);
    await expect(
      (fixture.processor as any).dispatch({ tenantId: tenantA, campaignId: 'campaign-1' }),
    ).rejects.toThrow(channel === Channel.CALL ? 'not supported' : 'Unsupported campaign channel');
    expect(fixture.queue.enqueue).not.toHaveBeenCalled();
    expect(fixture.prisma.campaign.update).not.toHaveBeenCalled();
    expect(fixture.prisma.campaignRecipient.findMany).not.toHaveBeenCalled();
  });

  it('treats a non-retryable mock provider rejection as terminal', async () => {
    const fixture = processorFixture(Channel.WHATSAPP);
    await fixture.tenantContext.runAsWorker(tenantA, 'test mock permanent failure', () =>
      (fixture.processor as any).handleSendFailure(
        'recipient-1',
        'contact-1',
        'campaign-1',
        Channel.WHATSAPP,
        new MockProviderError('whatsapp', 'sendTemplate', 'invalid_recipient', 'invalid recipient', false),
      ),
    );

    expect(fixture.prisma.campaignRecipient.update).toHaveBeenCalledWith({
      where: { id: 'recipient-1' },
      data: expect.objectContaining({ status: RecipientStatus.FAILED, errorCode: 'invalid_recipient' }),
    });
    expect(fixture.campaigns.finalizeIfDone).toHaveBeenCalledWith('campaign-1');
  });

  it('does not dispatch a completed campaign', async () => {
    const fixture = processorFixture(Channel.WHATSAPP);
    fixture.recipient.campaign.status = CampaignStatus.COMPLETED;
    await expect(
      (fixture.processor as any).dispatch({ tenantId: tenantA, campaignId: 'campaign-1' }),
    ).rejects.toThrow('not dispatchable');
    expect(fixture.queue.enqueue).not.toHaveBeenCalled();
    expect(fixture.prisma.campaignRecipient.findMany).not.toHaveBeenCalled();
  });

  it('rejects CALL launch before templates, recipients, wallet checks, or queueing', async () => {
    const tenantContext = new TenantContext();
    const campaign = {
      id: 'campaign-1',
      tenantId: tenantA,
      name: 'Voice campaign',
      channel: Channel.CALL,
      status: CampaignStatus.DRAFT,
      templateId: 'template-1',
    };
    const prisma = {
      campaign: { findUnique: jest.fn().mockResolvedValue(campaign) },
      $transaction: jest.fn(),
    };
    const templates = { assertLaunchable: jest.fn() };
    const metering = { estimate: jest.fn() };
    const wallet = { checkAffordable: jest.fn() };
    const queue = { enqueue: jest.fn() };
    const service = new CampaignsService(
      prisma as any,
      templates as any,
      metering as any,
      wallet as any,
      queue as any,
      {} as any,
      tenantContext,
    );

    await expect(
      tenantContext.runAsWorker(tenantA, 'test CALL launch rejection', () => service.launch(campaign.id)),
    ).rejects.toThrow('Voice campaign execution is not supported yet');
    expect(templates.assertLaunchable).not.toHaveBeenCalled();
    expect(metering.estimate).not.toHaveBeenCalled();
    expect(wallet.checkAffordable).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a draft that references a template outside the active tenant', async () => {
    const tenantContext = new TenantContext();
    const prisma = { campaign: { create: jest.fn(), update: jest.fn() } };
    const templates = {
      assertLaunchable: jest.fn().mockRejectedValue(new NotFoundException('Template', 'foreign-template')),
    };
    const service = new CampaignsService(
      prisma as any,
      templates as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      tenantContext,
    );

    await expect(
      tenantContext.runAsWorker(tenantA, 'test foreign template rejection', () =>
        service.create(
          {
            name: 'Foreign template attempt',
            channel: Channel.WHATSAPP,
            templateId: 'foreign-template',
            filter: { all: true },
          },
          'user-a',
        ),
      ),
    ).rejects.toThrow('Template');
    expect(prisma.campaign.create).not.toHaveBeenCalled();
  });

  it('keeps duplicate launch safe without new financial or queue side effects', async () => {
    const tenantContext = new TenantContext();
    const prisma = {
      campaign: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'campaign-1',
          tenantId: tenantA,
          name: 'Already launched',
          channel: Channel.WHATSAPP,
          status: CampaignStatus.QUEUED,
        }),
      },
      $transaction: jest.fn(),
    };
    const metering = { estimate: jest.fn() };
    const wallet = { checkAffordable: jest.fn() };
    const queue = { enqueue: jest.fn() };
    const service = new CampaignsService(
      prisma as any,
      {} as any,
      metering as any,
      wallet as any,
      queue as any,
      {} as any,
      tenantContext,
    );

    await expect(
      tenantContext.runAsWorker(tenantA, 'test duplicate launch', () => service.launch('campaign-1')),
    ).rejects.toThrow('cannot be launched again');
    expect(metering.estimate).not.toHaveBeenCalled();
    expect(wallet.checkAffordable).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects resuming an unsupported CALL campaign before wallet activity', async () => {
    const tenantContext = new TenantContext();
    const prisma = {
      campaign: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'campaign-1',
          tenantId: tenantA,
          name: 'Old voice campaign',
          channel: Channel.CALL,
          status: CampaignStatus.HALTED_INSUFFICIENT_FUNDS,
        }),
      },
      campaignRecipient: { count: jest.fn() },
      $transaction: jest.fn(),
    };
    const metering = { estimate: jest.fn() };
    const wallet = { checkAffordable: jest.fn() };
    const queue = { enqueue: jest.fn() };
    const service = new CampaignsService(
      prisma as any,
      {} as any,
      metering as any,
      wallet as any,
      queue as any,
      {} as any,
      tenantContext,
    );
    await expect(
      tenantContext.runAsWorker(tenantA, 'test CALL resume rejection', () => service.resume('campaign-1')),
    ).rejects.toThrow('Voice campaign execution is not supported yet');
    expect(prisma.campaignRecipient.count).not.toHaveBeenCalled();
    expect(metering.estimate).not.toHaveBeenCalled();
    expect(wallet.checkAffordable).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('skips an archived contact before provider or wallet activity', async () => {
    const fixture = processorFixture(Channel.WHATSAPP, { deletedAt: new Date() });
    await (fixture.processor as any).sendWhatsApp({
      tenantId: tenantA,
      campaignRecipientId: fixture.recipient.id,
    });
    expect(fixture.prisma.campaignRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorCode: 'contact_archived' }) }),
    );
    expect(fixture.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(fixture.metering.reserve).not.toHaveBeenCalled();
    expect(fixture.metering.settle).not.toHaveBeenCalled();
    expect(fixture.campaigns.finalizeIfDone).toHaveBeenCalledWith(fixture.recipient.campaign.id);
  });

  it('blocks a stale CALL recipient already present in the WhatsApp worker', async () => {
    const fixture = processorFixture(Channel.CALL);
    await expect(
      (fixture.processor as any).sendWhatsApp({ tenantId: tenantA, campaignRecipientId: fixture.recipient.id }),
    ).rejects.toThrow('not the WhatsApp worker');
    expect(fixture.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(fixture.metering.reserve).not.toHaveBeenCalled();
    expect(fixture.metering.settle).not.toHaveBeenCalled();
  });

  it('blocks a stale CALL recipient already present in the Email worker', async () => {
    const fixture = processorFixture(Channel.CALL);
    await expect(
      (fixture.processor as any).sendEmail({ tenantId: tenantA, campaignRecipientId: fixture.recipient.id }),
    ).rejects.toThrow('not the email worker');
    expect(fixture.email.send).not.toHaveBeenCalled();
    expect(fixture.metering.reserve).not.toHaveBeenCalled();
    expect(fixture.metering.settle).not.toHaveBeenCalled();
  });

  it('sends and settles an active WhatsApp recipient only through WhatsApp', async () => {
    const fixture = processorFixture(Channel.WHATSAPP);
    await (fixture.processor as any).sendWhatsApp({ tenantId: tenantA, campaignRecipientId: fixture.recipient.id });
    expect(fixture.whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
    expect(fixture.email.send).not.toHaveBeenCalled();
    expect(fixture.metering.reserve).toHaveBeenCalledTimes(1);
    expect(fixture.metering.settle).toHaveBeenCalledTimes(1);
  });

  it('sends and settles an active Email recipient only through Email', async () => {
    const fixture = processorFixture(Channel.EMAIL);
    await (fixture.processor as any).sendEmail({ tenantId: tenantA, campaignRecipientId: fixture.recipient.id });
    expect(fixture.email.send).toHaveBeenCalledTimes(1);
    expect(fixture.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(fixture.metering.reserve).toHaveBeenCalledTimes(1);
    expect(fixture.metering.settle).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.campaignRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: 'mock-email' }) }),
    );
  });

  it('isolates Email shadow enqueue failure after settlement and recipient persistence', async () => {
    const shadow = { rateRecipient: jest.fn(), reconcileCampaign: jest.fn() };
    const fixture = processorFixture(Channel.EMAIL, {}, shadow);
    fixture.queue.enqueue.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(
      (fixture.processor as any).sendEmail({ tenantId: tenantA, campaignRecipientId: fixture.recipient.id }),
    ).resolves.toBeUndefined();

    expect(fixture.email.send).toHaveBeenCalledTimes(1);
    expect(fixture.metering.settle).toHaveBeenCalledTimes(1);
    expect(fixture.metering.release).not.toHaveBeenCalled();
    expect(fixture.prisma.campaignRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: RecipientStatus.SENT }) }),
    );
    expect(fixture.queue.enqueue).toHaveBeenCalledWith(
      'email-shadow-rate',
      { tenantId: tenantA, campaignRecipientId: fixture.recipient.id },
      { jobId: `email-shadow-rate:${fixture.recipient.id}`, attempts: 5 },
    );
    expect(fixture.campaigns.finalizeIfDone).toHaveBeenCalledWith(fixture.recipient.campaign.id);
  });

  it('refuses a recipient whose related rows do not belong to the job tenant', async () => {
    const fixture = processorFixture(Channel.WHATSAPP, { tenantId: tenantB });
    await expect(
      (fixture.processor as any).sendWhatsApp({ tenantId: tenantA, campaignRecipientId: fixture.recipient.id }),
    ).rejects.toThrow('does not belong to tenant');
    expect(fixture.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(fixture.metering.reserve).not.toHaveBeenCalled();
    expect(fixture.metering.settle).not.toHaveBeenCalled();
  });
});
