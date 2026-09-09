import { generateKeyPairSync, sign } from 'node:crypto';

import type { AppConfig } from '../../config/configuration';
import {
  parseSnsEnvelope,
  snsCanonicalMessage,
  SnsVerifier,
  type SnsEnvelope,
  validateSnsCertificateUrl,
} from './sns-verifier';

describe('AWS SNS verification', () => {
  const topicArn = 'arn:aws:sns:ap-south-1:123456789012:ses-events';
  const certUrl = 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-test.pem';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const originalFetch = global.fetch;

  function envelope(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
    const value: SnsEnvelope = {
      Type: 'Notification',
      MessageId: 'sns-message-1',
      TopicArn: topicArn,
      Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'ses-message-1' } }),
      Timestamp: '2026-01-01T00:00:00.000Z',
      SignatureVersion: '2',
      Signature: '',
      SigningCertURL: certUrl,
      ...overrides,
    };
    if (overrides.Signature === undefined) {
      value.Signature = sign(
        value.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
        Buffer.from(snsCanonicalMessage(value)),
        keys.privateKey,
      ).toString('base64');
    }
    return value;
  }

  function verifier(topics = [topicArn], config: Partial<AppConfig['email']> = {}): SnsVerifier {
    return new SnsVerifier({
      email: {
        snsTopicArns: topics,
        snsCertFetchTimeoutMs: 20,
        snsCertMaxBytes: 16 * 1024,
        snsCertCacheTtlMs: 60_000,
        ...config,
      },
    } as AppConfig);
  }

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(new Response(publicKey, { status: 200 }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each(['1', '2'] as const)('accepts a valid SignatureVersion %s notification', async (version) => {
    await expect(verifier().verify(envelope({ SignatureVersion: version }))).resolves.toBeUndefined();
  });

  it('includes an optional Subject in the verified canonical Notification', async () => {
    await expect(verifier().verify(envelope({ Subject: 'Delivery event' }))).resolves.toBeUndefined();
  });

  it('verifies the confirmation-specific SubscribeURL and Token fields', async () => {
    await expect(
      verifier().verify(
        envelope({
          Type: 'SubscriptionConfirmation',
          SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/confirm?id=test',
          Token: 'test-token',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('fetches certificates without forwarding authorization or application credentials', async () => {
    await verifier().verify(envelope());
    const [requestedUrl, request] = (global.fetch as jest.Mock).mock.calls[0] as [URL, RequestInit];
    expect(String(requestedUrl)).toBe(certUrl);
    expect(request).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/x-pem-file' },
    });
    expect(request.headers).not.toHaveProperty('authorization');
  });

  it('rejects a modified Message', async () => {
    const value = envelope();
    value.Message = 'modified';
    await expect(verifier().verify(value)).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('rejects a modified TopicArn', async () => {
    const value = envelope();
    value.TopicArn = 'arn:aws:sns:ap-south-1:123456789012:modified';
    await expect(verifier().verify(value)).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('rejects an invalid Signature', async () => {
    await expect(verifier().verify(envelope({ Signature: 'invalid' }))).rejects.toMatchObject({
      code: 'invalid_signature',
    });
  });

  it('rejects an unsupported SignatureVersion', () => {
    expect(() => parseSnsEnvelope({ ...envelope(), SignatureVersion: '3' })).toThrow('unsupported');
  });

  it.each([
    'http://sns.ap-south-1.amazonaws.com/SimpleNotificationService-test.pem',
    'https://localhost/SimpleNotificationService-test.pem',
    'https://127.0.0.1/SimpleNotificationService-test.pem',
    'https://sns.ap-south-1.amazonaws.com.evil.test/SimpleNotificationService-test.pem',
  ])('rejects untrusted certificate URL %s', (url) => {
    expect(() => validateSnsCertificateUrl(url)).toThrow('not trusted');
  });

  it('accepts a legitimate regional SNS certificate hostname', () => {
    expect(validateSnsCertificateUrl(certUrl).hostname).toBe('sns.ap-south-1.amazonaws.com');
  });

  it('rejects a correctly signed message from an unexpected topic', async () => {
    const otherTopic = 'arn:aws:sns:ap-south-1:123456789012:other-events';
    await expect(verifier().verify(envelope({ TopicArn: otherTopic }))).rejects.toMatchObject({
      code: 'unexpected_topic',
    });
  });

  it('handles certificate fetch timeout without exposing fetch details', async () => {
    global.fetch = jest.fn().mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error('internal connection detail');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    await expect(verifier().verify(envelope())).rejects.toMatchObject({
      code: 'cert_fetch_timeout',
      message: 'SNS signing certificate could not be retrieved',
    });
  });

  it('rejects an oversized certificate response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('x'.repeat(2048), { status: 200, headers: { 'content-length': '2048' } }),
    );
    await expect(verifier([topicArn], { snsCertMaxBytes: 1024 }).verify(envelope())).rejects.toMatchObject({
      code: 'certificate_too_large',
    });
  });

  it('rejects a certificate redirect to an untrusted host', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://evil.test/certificate.pem' } }),
    );
    await expect(verifier().verify(envelope())).rejects.toMatchObject({ code: 'invalid_cert_url' });
  });
});
