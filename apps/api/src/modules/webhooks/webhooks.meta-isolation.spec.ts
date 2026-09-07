import { Prisma } from '@prisma/client';

import { signMeta } from '../../common/crypto/signatures';
import { WebhooksService } from './webhooks.service';

describe('Meta inbound routing envelope', () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'receiver-a' },
                messages: [
                  {
                    id: 'wamid-1',
                    from: '919876543210',
                    timestamp: '1767225600',
                    type: 'text',
                    text: { body: 'Where is my shipment?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );

  function fixture() {
    let processed = false;
    const duplicate = () =>
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['provider', 'provider_event_id'] },
      });
    const prisma = {
      webhookDelivery: {
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          if (data.signatureVerified === false) return { id: 'rejected-1' };
          if (processed) throw duplicate();
          return { id: 'delivery-1' };
        }),
        findFirst: jest.fn().mockImplementation(async () => ({
          id: 'delivery-1',
          processed,
          processing: false,
          processingStartedAt: null,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          if (data.processed === true) processed = true;
          return { id: 'delivery-1' };
        }),
      },
    };
    const campaigns = {
      applyInboundMessage: jest.fn().mockResolvedValue(undefined),
      applyDeliveryStatus: jest.fn(),
      applyEmailComplaint: jest.fn(),
    };
    const service = new WebhooksService(
      prisma as any,
      {
        whatsapp: { appSecret: 'meta-secret', verifyToken: 'verify-token' },
        razorpay: { webhookSecret: 'razorpay-secret' },
        plivo: { authToken: 'plivo-token' },
        email: { mockWebhookSecret: 'email-secret', snsTopicArns: [] },
        providers: { email: 'mock' },
      } as any,
      {} as any,
      campaigns as any,
      {} as any,
      {} as any,
      { verify: jest.fn() } as any,
    );
    return { service, prisma, campaigns };
  }

  it('passes the verified receiving phone number id into tenant resolution', async () => {
    const { service, campaigns } = fixture();
    await service.handleMeta(rawBody, signMeta('meta-secret', rawBody));
    expect(campaigns.applyInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: 'wamid-1',
        phoneNumberId: 'receiver-a',
        from: '919876543210',
      }),
    );
  });

  it('never reaches tenant resolution when the Meta signature is invalid', async () => {
    const { service, campaigns } = fixture();
    await expect(service.handleMeta(rawBody, 'sha256=invalid')).rejects.toThrow('signature verification failed');
    expect(campaigns.applyInboundMessage).not.toHaveBeenCalled();
  });

  it('uses the existing webhook delivery key to dispatch a duplicate message only once', async () => {
    const { service, campaigns } = fixture();
    const signature = signMeta('meta-secret', rawBody);
    await service.handleMeta(rawBody, signature);
    await service.handleMeta(rawBody, signature);
    expect(campaigns.applyInboundMessage).toHaveBeenCalledTimes(1);
  });
});
