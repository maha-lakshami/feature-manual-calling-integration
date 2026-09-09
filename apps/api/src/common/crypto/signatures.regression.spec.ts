import {
  signMeta,
  signPlivoV3,
  signRazorpayWebhook,
  verifyMetaSignature,
  verifyPlivoV3Signature,
  verifyRazorpayWebhookSignature,
} from './signatures';

describe('non-email webhook signature regressions', () => {
  it('preserves Meta HMAC verification and rejects modification', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = signMeta('meta-secret', body);
    expect(verifyMetaSignature('meta-secret', body, signature)).toBe(true);
    expect(verifyMetaSignature('meta-secret', Buffer.from('{}'), signature)).toBe(false);
  });

  it('preserves Razorpay HMAC verification and rejects modification', () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const signature = signRazorpayWebhook('razorpay-secret', body);
    expect(verifyRazorpayWebhookSignature('razorpay-secret', body, signature)).toBe(true);
    expect(verifyRazorpayWebhookSignature('razorpay-secret', Buffer.from('{}'), signature)).toBe(false);
  });

  it('preserves Plivo V3 URL-plus-nonce verification and rejects modification', () => {
    const url = 'https://api.example.test/webhooks/plivo/status';
    const signature = signPlivoV3('plivo-token', url, 'nonce-1');
    expect(verifyPlivoV3Signature('plivo-token', url, 'nonce-1', signature)).toBe(true);
    expect(verifyPlivoV3Signature('plivo-token', `${url}?modified=1`, 'nonce-1', signature)).toBe(false);
  });
});
