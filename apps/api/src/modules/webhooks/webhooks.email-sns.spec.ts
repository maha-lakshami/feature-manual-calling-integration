import { Channel, ProviderMode, RecipientStatus } from '@aiking/shared';
import { Prisma } from '@prisma/client';

import { WebhooksService } from './webhooks.service';
import { SnsVerificationError } from './sns-verifier';

describe('SNS email webhook dispatch', () => {
  function body(eventType: string, envelopeOverrides: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        Type: 'Notification',
        MessageId: 'sns-1',
        TopicArn: 'arn:aws:sns:ap-south-1:123456789012:ses-events',
        Message: JSON.stringify({
          eventType,
          mail: { messageId: 'ses-1', timestamp: '2026-01-01T00:00:00Z' },
          delivery: { timestamp: '2026-01-01T00:00:01Z' },
          bounce: {
            timestamp: '2026-01-01T00:00:01Z',
            bounceType: 'Permanent',
            bouncedRecipients: [{ diagnosticCode: 'mailbox unavailable' }],
          },
          complaint: { timestamp: '2026-01-01T00:00:01Z', complaintFeedbackType: 'abuse' },
        }),
        Timestamp: '2026-01-01T00:00:00Z',
        SignatureVersion: '2',
        Signature: 'test-signature',
        SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-test.pem',
        ...envelopeOverrides,
      }),
    );
  }

  function fixture() {
    let exists = false;
    let processed = false;
    let processing = false;
    const prisma = {
      webhookDelivery: {
        create: jest.fn().mockImplementation(async () => {
          if (exists) {
            throw new Prisma.PrismaClientKnownRequestError('duplicate', {
              code: 'P2002',
              clientVersion: '7.10.0',
            });
          }
          exists = true;
          processing = true;
          return { id: 'delivery-1' };
        }),
        findFirst: jest.fn().mockImplementation(async () => ({
          id: 'delivery-1',
          processed,
          processing,
          processingStartedAt: processing ? new Date() : null,
        })),
        updateMany: jest.fn().mockImplementation(async () => {
          if (processing) return { count: 0 };
          processing = true;
          return { count: 1 };
        }),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          processed = data.processed;
          processing = data.processing;
          return { id: 'delivery-1' };
        }),
      },
    };
    const campaigns = {
      applyDeliveryStatus: jest.fn().mockResolvedValue(undefined),
      applyEmailComplaint: jest.fn().mockResolvedValue(undefined),
      applyInboundMessage: jest.fn(),
    };
    const snsVerifier = { verify: jest.fn().mockResolvedValue(undefined) };
    const service = new WebhooksService(
      prisma as any,
      {
        providers: { email: ProviderMode.LIVE },
        email: { mockWebhookSecret: 'mock-only-secret', snsTopicArns: [] },
        whatsapp: {},
        razorpay: {},
        plivo: {},
      } as any,
      {} as any,
      campaigns as any,
      {} as any,
      {} as any,
      snsVerifier as any,
    );
    return { service, prisma, campaigns, snsVerifier };
  }

  it('never reaches SES dispatch when SNS verification fails', async () => {
    const { service, campaigns, snsVerifier } = fixture();
    snsVerifier.verify.mockRejectedValueOnce(new Error('invalid signature'));
    await expect(service.handleEmail(body('Delivery'))).rejects.toThrow('email webhook signature verification failed');
    expect(campaigns.applyDeliveryStatus).not.toHaveBeenCalled();
    expect(campaigns.applyEmailComplaint).not.toHaveBeenCalled();
  });

  it('returns a retryable 5xx when certificate retrieval is temporarily unavailable', async () => {
    const { service, campaigns, snsVerifier } = fixture();
    snsVerifier.verify.mockRejectedValueOnce(
      new SnsVerificationError('cert_fetch_timeout', 'SNS signing certificate could not be retrieved'),
    );
    await expect(service.handleEmail(body('Delivery'))).rejects.toMatchObject({ status: 503 });
    expect(campaigns.applyDeliveryStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['Delivery', RecipientStatus.DELIVERED],
    ['Bounce', RecipientStatus.BOUNCED],
  ] as const)('processes a verified %s event', async (eventType, status) => {
    const { service, campaigns } = fixture();
    await service.handleEmail(body(eventType));
    expect(campaigns.applyDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'ses-1', channel: Channel.EMAIL, status }),
    );
  });

  it('processes a verified Complaint through the suppression path', async () => {
    const { service, campaigns } = fixture();
    await service.handleEmail(body('Complaint'));
    expect(campaigns.applyEmailComplaint).toHaveBeenCalledWith('ses-1');
    expect(campaigns.applyDeliveryStatus).not.toHaveBeenCalled();
  });

  it('explicitly acknowledges an unknown SES event without business mutation', async () => {
    const { service, campaigns } = fixture();
    await expect(service.handleEmail(body('RenderingFailure'))).resolves.toEqual({
      received: true,
      processed: false,
      duplicate: false,
    });
    expect(campaigns.applyDeliveryStatus).not.toHaveBeenCalled();
    expect(campaigns.applyEmailComplaint).not.toHaveBeenCalled();
  });

  it('does not repeat a side effect for a duplicate valid SNS notification', async () => {
    const { service, campaigns } = fixture();
    await service.handleEmail(body('Delivery'));
    await expect(service.handleEmail(body('Delivery'))).resolves.toMatchObject({ duplicate: true });
    expect(campaigns.applyDeliveryStatus).toHaveBeenCalledTimes(1);
  });

  it('leaves transient processing failure retryable for the same SNS MessageId', async () => {
    const { service, campaigns } = fixture();
    campaigns.applyDeliveryStatus.mockRejectedValueOnce(new Error('temporary database outage'));
    await expect(service.handleEmail(body('Delivery'))).rejects.toThrow('temporary database outage');
    await expect(service.handleEmail(body('Delivery'))).resolves.toMatchObject({ processed: true });
    expect(campaigns.applyDeliveryStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['SubscriptionConfirmation', 'UnsubscribeConfirmation'])('verifies but never follows %s URLs', async (Type) => {
    const { service, campaigns, snsVerifier } = fixture();
    const raw = body('Delivery', {
      Type,
      SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/confirm?id=test',
      Token: 'subscription-token',
    });
    await expect(service.handleEmail(raw)).resolves.toMatchObject({ processed: false });
    expect(snsVerifier.verify).toHaveBeenCalledTimes(1);
    expect(campaigns.applyDeliveryStatus).not.toHaveBeenCalled();
  });
});
