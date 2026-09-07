import { Inject, Injectable } from '@nestjs/common';
import { verify as verifySignature } from 'node:crypto';
import { isIP } from 'node:net';

import { CONFIG, type AppConfig } from '../../config/configuration';

export type SnsMessageType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';

export interface SnsEnvelope {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

export class SnsVerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SnsVerificationError';
  }
}

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/;
const CERT_PATH = /^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/;

export function validateSnsCertificateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SnsVerificationError('invalid_cert_url', 'SNS signing certificate URL is malformed');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    isIP(hostname) !== 0 ||
    !CERT_HOST.test(hostname) ||
    !CERT_PATH.test(url.pathname)
  ) {
    throw new SnsVerificationError('invalid_cert_url', 'SNS signing certificate URL is not trusted');
  }
  return url;
}

export function parseSnsEnvelope(payload: Record<string, unknown>): SnsEnvelope | null {
  const type = payload.Type;
  if (!['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(String(type))) return null;

  const required = [
    'MessageId',
    'TopicArn',
    'Message',
    'Timestamp',
    'SignatureVersion',
    'Signature',
    'SigningCertURL',
  ] as const;
  if (required.some((field) => typeof payload[field] !== 'string' || payload[field].length === 0)) return null;
  if (payload.SignatureVersion !== '1' && payload.SignatureVersion !== '2') {
    throw new SnsVerificationError('unsupported_signature_version', 'SNS signature version is unsupported');
  }

  const confirmation = type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation';
  if (
    confirmation &&
    (typeof payload.SubscribeURL !== 'string' || !payload.SubscribeURL || typeof payload.Token !== 'string' || !payload.Token)
  ) {
    return null;
  }

  return {
    Type: type as SnsMessageType,
    MessageId: payload.MessageId as string,
    TopicArn: payload.TopicArn as string,
    Message: payload.Message as string,
    Timestamp: payload.Timestamp as string,
    SignatureVersion: payload.SignatureVersion,
    Signature: payload.Signature as string,
    SigningCertURL: payload.SigningCertURL as string,
    ...(typeof payload.Subject === 'string' ? { Subject: payload.Subject } : {}),
    ...(confirmation ? { SubscribeURL: payload.SubscribeURL as string, Token: payload.Token as string } : {}),
  };
}

export function snsCanonicalMessage(envelope: SnsEnvelope): string {
  const fields: Array<keyof SnsEnvelope> =
    envelope.Type === 'Notification'
      ? ['Message', 'MessageId', ...(envelope.Subject !== undefined ? (['Subject'] as const) : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return `${fields.map((field) => `${field}\n${envelope[field]}\n`).join('')}`;
}

@Injectable()
export class SnsVerifier {
  private readonly certificateCache = new Map<string, { pem: string; expiresAt: number }>();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async verify(envelope: SnsEnvelope): Promise<void> {
    if (!Number.isFinite(Date.parse(envelope.Timestamp))) {
      throw new SnsVerificationError('invalid_timestamp', 'SNS timestamp is invalid');
    }
    const certificateUrl = validateSnsCertificateUrl(envelope.SigningCertURL);
    const certificate = await this.certificate(certificateUrl);
    const algorithm = envelope.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
    let signature: Buffer;
    try {
      signature = Buffer.from(envelope.Signature, 'base64');
      if (signature.length === 0) throw new Error();
    } catch {
      throw new SnsVerificationError('invalid_signature', 'SNS signature is invalid');
    }
    let verified = false;
    try {
      verified = verifySignature(algorithm, Buffer.from(snsCanonicalMessage(envelope), 'utf8'), certificate, signature);
    } catch {
      throw new SnsVerificationError('invalid_certificate', 'SNS signing certificate is invalid');
    }
    if (!verified) throw new SnsVerificationError('invalid_signature', 'SNS signature verification failed');
    if (!this.config.email.snsTopicArns.includes(envelope.TopicArn)) {
      throw new SnsVerificationError('unexpected_topic', 'SNS topic is not configured for email callbacks');
    }
  }

  private async certificate(initialUrl: URL): Promise<string> {
    const cached = this.certificateCache.get(initialUrl.href);
    if (cached && cached.expiresAt > Date.now()) return cached.pem;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.email.snsCertFetchTimeoutMs);
    try {
      let url = initialUrl;
      for (let redirects = 0; redirects <= 2; redirects += 1) {
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: { accept: 'application/x-pem-file' },
          });
        } catch (error) {
          const code = (error as { name?: string }).name === 'AbortError' ? 'cert_fetch_timeout' : 'cert_fetch_failed';
          throw new SnsVerificationError(code, 'SNS signing certificate could not be retrieved');
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirects === 2) {
            throw new SnsVerificationError('cert_redirect_rejected', 'SNS certificate redirect was rejected');
          }
          url = validateSnsCertificateUrl(new URL(location, url).href);
          continue;
        }
        if (!response.ok) throw new SnsVerificationError('cert_fetch_failed', 'SNS signing certificate could not be retrieved');

        const pem = await this.readBoundedCertificate(response);
        if (this.certificateCache.size >= 32) this.certificateCache.delete(this.certificateCache.keys().next().value!);
        this.certificateCache.set(initialUrl.href, {
          pem,
          expiresAt: Date.now() + this.config.email.snsCertCacheTtlMs,
        });
        return pem;
      }
      throw new SnsVerificationError('cert_redirect_rejected', 'SNS certificate redirect was rejected');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBoundedCertificate(response: Response): Promise<string> {
    const maximum = this.config.email.snsCertMaxBytes;
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > maximum) {
      throw new SnsVerificationError('certificate_too_large', 'SNS signing certificate response is too large');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SnsVerificationError('invalid_certificate', 'SNS signing certificate response is empty');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      let part: { done: boolean; value?: Uint8Array };
      try {
        part = await reader.read();
      } catch (error) {
        const code = (error as { name?: string }).name === 'AbortError' ? 'cert_fetch_timeout' : 'cert_fetch_failed';
        throw new SnsVerificationError(code, 'SNS signing certificate could not be retrieved');
      }
      if (part.done) break;
      if (!part.value) continue;
      total += part.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new SnsVerificationError('certificate_too_large', 'SNS signing certificate response is too large');
      }
      chunks.push(Buffer.from(part.value));
    }
    const pem = Buffer.concat(chunks, total).toString('ascii');
    if (!pem.includes('-----BEGIN CERTIFICATE-----') && !pem.includes('-----BEGIN PUBLIC KEY-----')) {
      throw new SnsVerificationError('invalid_certificate', 'SNS signing certificate response is invalid');
    }
    return pem;
  }
}
