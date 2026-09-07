import { signRazorpayWebhook } from '../../common/crypto/signatures';
import { Prisma } from '@prisma/client';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService delivery lifecycle', () => {
  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError('duplicate webhook delivery', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: ['provider', 'provider_event_id'] },
    });
  const record = {
    provider: 'razorpay' as const,
    eventType: 'payment.captured',
    providerEventId: 'event-1',
    payload: {},
  };

  function createService(prisma: any = {}) {
    return new WebhooksService(
      prisma,
      {
        razorpay: { webhookSecret: 'test-webhook-secret' },
        whatsapp: { appSecret: 'meta-secret', verifyToken: 'verify-token' },
        plivo: { authToken: 'plivo-token', callbackBaseUrl: 'https://api.example.com' },
        email: { mockWebhookSecret: 'email-secret', snsTopicArns: [] },
      } as any,
      { recordCapturedPayment: jest.fn().mockResolvedValue(undefined), recordFailedPayment: jest.fn() } as any,
      { applyDeliveryStatus: jest.fn(), applyInboundMessage: jest.fn(), applyEmailComplaint: jest.fn() } as any,
      { applyCallEvent: jest.fn(), applyRecordingReady: jest.fn() } as any,
      { runAsSystem: jest.fn((_reason: string, callback: () => unknown) => callback()) } as any,
      { verify: jest.fn() } as any,
    );
  }

  function deliveryPrisma(overrides: Record<string, unknown> = {}) {
    return {
      webhookDelivery: {
        create: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        ...overrides,
      },
    };
  }

  it('creates, dispatches, and marks the first delivery processed', async () => {
    const prisma = deliveryPrisma({ create: jest.fn().mockResolvedValue({ id: 'delivery-1' }) });
    const service = createService(prisma);
    const dispatch = jest.fn().mockResolvedValue(undefined);

    await expect((service as any).withDelivery(record, dispatch)).resolves.toEqual({
      received: true,
      processed: true,
      duplicate: false,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: { processed: true, processing: false, processingStartedAt: null, errorMessage: null },
    });
  });

  it('acknowledges a processed duplicate without dispatching', async () => {
    const prisma = deliveryPrisma({
      create: jest.fn().mockRejectedValue(uniqueViolation()),
      findFirst: jest.fn().mockResolvedValue({ id: 'delivery-1', processed: true, processing: false, processingStartedAt: null }),
    });
    const service = createService(prisma);
    const dispatch = jest.fn();

    await expect((service as any).withDelivery(record, dispatch)).resolves.toEqual({
      received: true,
      processed: false,
      duplicate: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('clears a failed claim and returns the transient failure for provider retry', async () => {
    const failure = new Error('temporary database outage');
    const prisma = deliveryPrisma({ create: jest.fn().mockResolvedValue({ id: 'delivery-1' }) });
    const service = createService(prisma);

    await expect((service as any).withDelivery(record, jest.fn().mockRejectedValue(failure))).rejects.toBe(failure);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: {
        processed: false,
        processing: false,
        processingStartedAt: null,
        errorMessage: 'temporary database outage',
      },
    });
  });

  it('claims and processes the same event after a transient failure', async () => {
    const prisma = deliveryPrisma({
      create: jest.fn().mockRejectedValue(uniqueViolation()),
      findFirst: jest.fn().mockResolvedValue({ id: 'delivery-1', processed: false, processing: false, processingStartedAt: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    const service = createService(prisma);
    const dispatch = jest.fn().mockResolvedValue(undefined);

    await expect((service as any).withDelivery(record, dispatch)).resolves.toEqual({
      received: true,
      processed: true,
      duplicate: false,
    });
    expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('allows only one dispatch for concurrent duplicate requests', async () => {
    let deliveryExists = false;
    let releaseDispatch!: () => void;
    const dispatchBlocked = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const create = jest.fn().mockImplementation(async () => {
      if (deliveryExists) throw uniqueViolation();
      deliveryExists = true;
      return { id: 'delivery-1' };
    });
    const prisma = deliveryPrisma({
      create,
      findFirst: jest.fn().mockResolvedValue({
        id: 'delivery-1',
        processed: false,
        processing: true,
        processingStartedAt: new Date(),
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    });
    const service = createService(prisma);
    const dispatch = jest.fn().mockImplementation(() => dispatchBlocked);

    const first = (service as any).withDelivery(record, dispatch);
    await Promise.resolve();
    const duplicate = (service as any).withDelivery(record, dispatch);

    await expect(duplicate).rejects.toThrow('currently being processed');
    expect(dispatch).toHaveBeenCalledTimes(1);
    releaseDispatch();
    await expect(first).resolves.toEqual({ received: true, processed: true, duplicate: false });
  });

  it('does not dispatch an invalid Razorpay signature', async () => {
    const prisma = deliveryPrisma({ create: jest.fn().mockResolvedValue({ id: 'rejected-1' }) });
    const service = createService(prisma);

    await expect(service.handleRazorpay(Buffer.from('{"event":"payment.captured"}'), 'invalid')).rejects.toThrow(
      'razorpay webhook signature verification failed',
    );
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signatureVerified: false }) }),
    );
  });

  it('does not credit Razorpay twice when the same event is replayed', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay-1', order_id: 'order-1', amount: 500, method: 'card' } } },
      }),
    );
    const create = jest
      .fn()
      .mockResolvedValueOnce({ id: 'delivery-1' })
      .mockRejectedValueOnce(uniqueViolation());
    const findFirst = jest.fn().mockResolvedValue({ id: 'delivery-1', processed: true, processing: false, processingStartedAt: null });
    const prisma = deliveryPrisma({ create, findFirst });
    const service = createService(prisma);
    const razorpay = (service as any).razorpay;
    const signature = signRazorpayWebhook('test-webhook-secret', rawBody);

    await service.handleRazorpay(rawBody, signature, 'event-1');
    await service.handleRazorpay(rawBody, signature, 'event-1');

    expect(razorpay.recordCapturedPayment).toHaveBeenCalledTimes(1);
  });
});
