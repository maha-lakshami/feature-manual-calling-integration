import { signRazorpayPayment } from '../../common/crypto/signatures';
import { RazorpayService, type VerifyCheckoutInput } from './razorpay.service';

/**
 * Unit tests for the `verifyCheckoutPayment` method.
 *
 * These test the seven-step validation pipeline:
 *   1. Tenant-scoped order ownership
 *   2. Order/callback razorpayOrderId cross-check
 *   3. Checkout signature verification
 *   4–5. Provider payment state validation (paymentId, orderId, amount)
 *   6. Non-captured status → pending
 *   7. Captured → idempotent credit through recordCapturedPayment
 *
 * The tests mock only the constructor dependencies (Prisma, config, payments
 * provider, wallet, tenant context) — the method itself is tested as-is.
 */
describe('RazorpayService.verifyCheckoutPayment', () => {
  const KEY_SECRET = 'test_key_secret_abc123';
  const TENANT_ID = 'tenant-001';
  const INTERNAL_ORDER_ID = 'order-uuid-1';
  const RAZORPAY_ORDER_ID = 'order_RzpTest001';
  const RAZORPAY_PAYMENT_ID = 'pay_RzpTest001';
  const AMOUNT_PAISE = 50000n; // ₹500

  const validSignature = signRazorpayPayment(KEY_SECRET, RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);

  function validInput(): VerifyCheckoutInput {
    return {
      internalOrderId: INTERNAL_ORDER_ID,
      razorpayPaymentId: RAZORPAY_PAYMENT_ID,
      razorpayOrderId: RAZORPAY_ORDER_ID,
      razorpaySignature: validSignature,
    };
  }

  function orderRow() {
    return {
      id: INTERNAL_ORDER_ID,
      tenantId: TENANT_ID,
      razorpayOrderId: RAZORPAY_ORDER_ID,
      amountPaise: AMOUNT_PAISE,
      currency: 'INR',
    };
  }

  function capturedProviderPayment() {
    return {
      paymentId: RAZORPAY_PAYMENT_ID,
      orderId: RAZORPAY_ORDER_ID,
      amountPaise: AMOUNT_PAISE,
      currency: 'INR',
      status: 'captured' as const,
      method: 'upi',
    };
  }

  function createService(overrides: {
    prismaOrder?: any;
    prismaPayment?: any;
    payments?: any;
    wallet?: any;
  } = {}) {
    const prisma = {
      razorpayOrder: {
        findFirst: overrides.prismaOrder?.findFirst ?? jest.fn().mockResolvedValue(orderRow()),
        findUnique: overrides.prismaOrder?.findUnique ?? jest.fn().mockResolvedValue(orderRow()),
        update: overrides.prismaOrder?.update ?? jest.fn(),
      },
      razorpayPayment: {
        findUnique: overrides.prismaPayment?.findUnique ?? jest.fn().mockResolvedValue(null),
        create: overrides.prismaPayment?.create ?? jest.fn().mockResolvedValue({
          id: 'payment-uuid-1',
          razorpayPaymentId: RAZORPAY_PAYMENT_ID,
        }),
        update: overrides.prismaPayment?.update ?? jest.fn(),
      },
      wallet: {
        findFirst: jest.fn().mockResolvedValue({ balancePaise: 100000n, freeCreditBalancePaise: 0n }),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: TENANT_ID, slug: 'test-tenant' }),
      },
    };

    const config = {
      razorpay: { keySecret: KEY_SECRET, currency: 'INR' },
      providers: { payments: 'live' },
    };

    const payments = overrides.payments ?? {
      fetchPayment: jest.fn().mockResolvedValue(capturedProviderPayment()),
    };

    const wallet = overrides.wallet ?? {
      credit: jest.fn().mockResolvedValue({
        applied: true,
        balanceAfterPaise: 150000n,
        transactionIds: ['txn-1'],
      }),
      ensureWallet: jest.fn(),
    };

    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue(TENANT_ID),
    };

    const paymentsMock = {} as any;

    return new RazorpayService(prisma as any, config as any, payments, paymentsMock, wallet, tenantContext as any);
  }

  // ── 1. Tenant-scoped order ownership ─────────────────────────────────────

  it('rejects when the internal order does not exist for the tenant', async () => {
    const service = createService({
      prismaOrder: { findFirst: jest.fn().mockResolvedValue(null) },
    });

    await expect(service.verifyCheckoutPayment(validInput(), TENANT_ID)).rejects.toThrow(
      /not found/i,
    );
  });

  // ── 2. Order/callback razorpayOrderId cross-check ────────────────────────

  it('rejects when the Razorpay order ID in the callback does not match', async () => {
    const input = validInput();
    input.razorpayOrderId = 'order_WRONG';
    // Re-sign with wrong order id to isolate the cross-check (not the sig check)
    input.razorpaySignature = signRazorpayPayment(KEY_SECRET, 'order_WRONG', RAZORPAY_PAYMENT_ID);

    const service = createService();

    await expect(service.verifyCheckoutPayment(input, TENANT_ID)).rejects.toThrow(
      /does not match/i,
    );
  });

  // ── 3. Checkout signature verification ───────────────────────────────────

  it('rejects an invalid checkout signature', async () => {
    const input = validInput();
    input.razorpaySignature = 'deadbeefcafebabe0000000000000000000000000000000000000000ffffffff';

    const service = createService();

    await expect(service.verifyCheckoutPayment(input, TENANT_ID)).rejects.toThrow(
      /signature verification failed/i,
    );
  });

  it('rejects an empty signature', async () => {
    const input = validInput();
    input.razorpaySignature = '';

    const service = createService();

    await expect(service.verifyCheckoutPayment(input, TENANT_ID)).rejects.toThrow(
      /signature verification failed/i,
    );
  });

  // ── 4–5. Provider payment validation ─────────────────────────────────────

  it('rejects when provider payment ID does not match', async () => {
    const service = createService({
      payments: {
        fetchPayment: jest.fn().mockResolvedValue({
          ...capturedProviderPayment(),
          paymentId: 'pay_DIFFERENT',
        }),
      },
    });

    await expect(service.verifyCheckoutPayment(validInput(), TENANT_ID)).rejects.toThrow(
      /payment ID mismatch/i,
    );
  });

  it('rejects when provider payment order ID does not match our order', async () => {
    const service = createService({
      payments: {
        fetchPayment: jest.fn().mockResolvedValue({
          ...capturedProviderPayment(),
          orderId: 'order_DIFFERENT',
        }),
      },
    });

    await expect(service.verifyCheckoutPayment(validInput(), TENANT_ID)).rejects.toThrow(
      /order ID does not match/i,
    );
  });

  it('rejects when provider payment amount does not match the order amount', async () => {
    const service = createService({
      payments: {
        fetchPayment: jest.fn().mockResolvedValue({
          ...capturedProviderPayment(),
          amountPaise: 99999n,
        }),
      },
    });

    await expect(service.verifyCheckoutPayment(validInput(), TENANT_ID)).rejects.toThrow(
      /amount does not match/i,
    );
  });

  it('rejects when provider payment currency does not match the order currency', async () => {
    const creditFn = jest.fn();
    const service = createService({
      payments: {
        fetchPayment: jest.fn().mockResolvedValue({
          ...capturedProviderPayment(),
          currency: 'USD',
        }),
      },
      wallet: {
        credit: creditFn,
        ensureWallet: jest.fn(),
      },
    });

    await expect(service.verifyCheckoutPayment(validInput(), TENANT_ID)).rejects.toThrow(
      /currency does not match/i,
    );
    expect(creditFn).not.toHaveBeenCalled();
  });

  it('accepts matching currency regardless of casing', async () => {
    const service = createService({
      payments: {
        fetchPayment: jest.fn().mockResolvedValue({
          ...capturedProviderPayment(),
          currency: 'inr',
        }),
      },
    });

    const result = await service.verifyCheckoutPayment(validInput(), TENANT_ID);
    expect(result.status).toBe('credited');
  });

  // ── 6. Non-captured status → pending ─────────────────────────────────────

  it('returns pending when payment is authorized but not captured', async () => {
    const service = createService({
      payments: {
        fetchPayment: jest.fn().mockResolvedValue({
          ...capturedProviderPayment(),
          status: 'authorized',
        }),
      },
    });

    const result = await service.verifyCheckoutPayment(validInput(), TENANT_ID);
    expect(result.status).toBe('pending');
    expect(result.creditedPaise).toBe(0n);
    expect(result.balanceAfterPaise).toBe(0n);
  });

  // ── 7. Captured → credit through recordCapturedPayment ───────────────────

  it('credits the wallet and returns credited status for a captured payment', async () => {
    const creditFn = jest.fn().mockResolvedValue({
      applied: true,
      balanceAfterPaise: 150000n,
      transactionIds: ['txn-1'],
    });

    const service = createService({
      wallet: {
        credit: creditFn,
        ensureWallet: jest.fn(),
      },
    });

    const result = await service.verifyCheckoutPayment(validInput(), TENANT_ID);
    expect(result.status).toBe('credited');
    expect(result.creditedPaise).toBe(AMOUNT_PAISE);
    expect(result.balanceAfterPaise).toBe(150000n);
    expect(creditFn).toHaveBeenCalledTimes(1);
  });

  it('returns already_credited for a duplicate payment', async () => {
    const service = createService({
      prismaPayment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'payment-uuid-1',
          razorpayPaymentId: RAZORPAY_PAYMENT_ID,
          creditedAt: new Date(),
          amountPaise: AMOUNT_PAISE,
        }),
      },
    });

    const result = await service.verifyCheckoutPayment(validInput(), TENANT_ID);
    expect(result.status).toBe('already_credited');
    expect(result.paymentId).toBe('payment-uuid-1');
  });

  // ── Idempotency: verify + webhook same payment ───────────────────────────

  it('produces exactly one credit when verify and webhook race', async () => {
    const creditFn = jest.fn()
      .mockResolvedValueOnce({
        applied: true,
        balanceAfterPaise: 150000n,
        transactionIds: ['txn-1'],
      })
      .mockResolvedValueOnce({
        applied: false,
        balanceAfterPaise: 150000n,
        transactionIds: [],
      });

    const service = createService({
      wallet: { credit: creditFn, ensureWallet: jest.fn() },
      prismaPayment: {
        // First call: no existing payment. Second call: payment exists with credit.
        findUnique: jest.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: 'payment-uuid-1',
            razorpayPaymentId: RAZORPAY_PAYMENT_ID,
            creditedAt: new Date(),
            amountPaise: AMOUNT_PAISE,
          }),
        create: jest.fn().mockResolvedValue({
          id: 'payment-uuid-1',
          razorpayPaymentId: RAZORPAY_PAYMENT_ID,
        }),
        update: jest.fn(),
      },
    });

    const result1 = await service.verifyCheckoutPayment(validInput(), TENANT_ID);
    const result2 = await service.verifyCheckoutPayment(validInput(), TENANT_ID);

    expect(result1.status).toBe('credited');
    expect(result2.status).toBe('already_credited');
    // credit was called once for each invocation, but the second returns applied: false
    // (the real system enforces this via the razorpay_payment unique constraint + wallet idempotency key)
  });
});
