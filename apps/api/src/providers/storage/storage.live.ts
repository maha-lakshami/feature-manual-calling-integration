import { Inject, Injectable } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';
import { createHash, createHmac } from 'node:crypto';

import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  ProviderError,
  type PutObjectInput,
  type PutObjectResult,
  type StorageProvider,
  type StoredObject,
} from '../provider.types';
import { assertTenantObjectKey, boundedSignedUrlExpiry, encodeS3Path } from './storage.security';

/**
 * Production-compatible S3 / Cloudflare R2 Storage Adapter.
 *
 * Implements S3 REST protocol using native fetch and standard AWS SigV4 signing.
 * Compatible with AWS S3, Cloudflare R2, MinIO, or any S3-compliant object store.
 * Keeps external vendor SDKs out of the business application bundle while enforcing:
 *
 * - Private objects by default (no public read ACL, no permanent public URLs)
 * - Time-limited, authenticated signed URLs for call recording playback
 * - Proper error normalization and retry flags
 */
@Injectable()
export class StorageLiveProvider implements StorageProvider {
  readonly name = 'storage';
  readonly mode = ProviderMode.LIVE;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private objectLocation(tenantId: string, key: string, operation: string): {
    host: string;
    uriPath: string;
    url: string;
  } {
    assertTenantObjectKey(tenantId, key, operation);
    const { host, origin, pathPrefix } = this.getEndpoint();
    const rawPath = `${pathPrefix}/${key}`;
    const uriPath = encodeS3Path(rawPath);
    return { host, uriPath, url: `${origin}${uriPath}` };
  }

  private getEndpoint(): { host: string; origin: string; pathPrefix: string } {
    const { bucket, region, endpoint, forcePathStyle } = this.config.storage;
    if (endpoint) {
      const parsed = new URL(endpoint);
      const origin = parsed.origin;
      const host = parsed.host;
      const pathPrefix = forcePathStyle ? `/${bucket}` : '';
      return { host, origin, pathPrefix };
    }
    if (forcePathStyle) {
      const host = `s3.${region}.amazonaws.com`;
      return { host, origin: `https://${host}`, pathPrefix: `/${bucket}` };
    }
    const host = `${bucket}.s3.${region}.amazonaws.com`;
    return { host, origin: `https://${host}`, pathPrefix: '' };
  }

  private getCredentials(): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
    const { accessKeyId, secretAccessKey, sessionToken } = this.config.storage;
    if (!accessKeyId || !secretAccessKey) {
      throw new ProviderError(
        'storage',
        'auth',
        'missing_credentials',
        'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured for StorageLiveProvider',
        false,
      );
    }
    return { accessKeyId, secretAccessKey, sessionToken };
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    if (input.body.length > this.config.storage.maxObjectBytes) {
      throw new ProviderError('storage', 'put', 'object_too_large', 'Object exceeds configured size limit', false);
    }
    const { accessKeyId, secretAccessKey, sessionToken } = this.getCredentials();
    if (/[\r\n]/.test(input.contentType) || (input.cacheControl && /[\r\n]/.test(input.cacheControl))) {
      throw new ProviderError('storage', 'put', 'invalid_headers', 'Object headers are invalid', false);
    }
    const { region } = this.config.storage;
    const { host, uriPath, url } = this.objectLocation(input.tenantId, input.key, 'put');

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = createHash('sha256').update(input.body).digest('hex');

    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'content-type': input.contentType || 'application/octet-stream',
      'cache-control': input.cacheControl || 'private, no-store',
    };

    if (sessionToken) {
      headers['x-amz-security-token'] = sessionToken;
    }

    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        if (!/^[a-z0-9-]+$/i.test(k) || /[\r\n]/.test(v)) {
          throw new ProviderError('storage', 'put', 'invalid_metadata', 'Object metadata is invalid', false);
        }
        headers[`x-amz-meta-${k.toLowerCase()}`] = String(v);
      }
    }

    headers['authorization'] = this.signRequest(
      'PUT',
      uriPath,
      '',
      headers,
      payloadHash,
      dateStamp,
      region,
      accessKeyId,
      secretAccessKey,
    );

    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers,
        body: input.body,
      });

      if (!res.ok) {
        throw new ProviderError(
          'storage',
          'put',
          `http_${res.status}`,
          `S3 PUT failed with HTTP ${res.status}`,
          res.status >= 500,
        );
      }

      const etag = res.headers.get('etag')?.replace(/"/g, '') || undefined;
      return {
        key: input.key,
        uri: `s3://${this.config.storage.bucket}/${input.key}`,
        sizeBytes: input.body.length,
        etag,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('storage', 'put', 'network_error', (err as Error).message, true);
    }
  }

  async get(tenantId: string, key: string): Promise<StoredObject | null> {
    const { accessKeyId, secretAccessKey, sessionToken } = this.getCredentials();
    const { region } = this.config.storage;
    const { host, uriPath, url } = this.objectLocation(tenantId, key, 'get');

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update('').digest('hex');

    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;

    headers['authorization'] = this.signRequest(
      'GET',
      uriPath,
      '',
      headers,
      payloadHash,
      dateStamp,
      region,
      accessKeyId,
      secretAccessKey,
    );

    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new ProviderError(
          'storage',
          'get',
          `http_${res.status}`,
          `S3 GET failed with HTTP ${res.status}`,
          res.status >= 500,
        );
      }

      const arrayBuf = await res.arrayBuffer();
      const body = Buffer.from(arrayBuf);
      const contentType = res.headers.get('content-type') || undefined;
      return { body, contentType };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('storage', 'get', 'network_error', (err as Error).message, true);
    }
  }

  async exists(tenantId: string, key: string): Promise<boolean> {
    const { accessKeyId, secretAccessKey, sessionToken } = this.getCredentials();
    const { region } = this.config.storage;
    const { host, uriPath, url } = this.objectLocation(tenantId, key, 'exists');

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update('').digest('hex');

    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;

    headers['authorization'] = this.signRequest(
      'HEAD',
      uriPath,
      '',
      headers,
      payloadHash,
      dateStamp,
      region,
      accessKeyId,
      secretAccessKey,
    );

    try {
      const res = await fetch(url, { method: 'HEAD', headers });
      if (res.status === 404) return false;
      return res.ok;
    } catch {
      return false;
    }
  }

  async signedUrl(tenantId: string, key: string, expiresInSeconds: number): Promise<string> {
    const { accessKeyId, secretAccessKey, sessionToken } = this.getCredentials();
    const { region } = this.config.storage;
    const { host, origin } = this.getEndpoint();
    const { uriPath } = this.objectLocation(tenantId, key, 'signedUrl');

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(
        boundedSignedUrlExpiry(expiresInSeconds, this.config.storage.signedUrlMaxExpirySeconds),
      ),
      'X-Amz-SignedHeaders': 'host',
    };

    if (sessionToken) {
      queryParams['X-Amz-Security-Token'] = sessionToken;
    }

    const canonicalQueryString = Object.keys(queryParams)
      .sort()
      .map((k) => `${encodeS3Path(k).replace(/\//g, '%2F')}=${encodeS3Path(queryParams[k]).replace(/\//g, '%2F')}`)
      .join('&');

    const canonicalHeaders = `host:${host}\n`;
    const canonicalRequest = ['GET', uriPath, canonicalQueryString, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `${origin}${uriPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  }

  private signRequest(
    method: string,
    uriPath: string,
    queryString: string,
    headers: Record<string, string>,
    payloadHash: string,
    dateStamp: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
  ): string {
    const sortedHeaderKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort();
    const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k].trim()}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [method, uriPath, queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      headers['x-amz-date'],
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }
}
