import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { MockBehavior } from '../mock-support';
import {
  ProviderError,
  type PutObjectInput,
  type PutObjectResult,
  type StorageProvider,
  type StoredObject,
} from '../provider.types';
import {
  assertTenantObjectKey,
  boundedSignedUrlExpiry,
  resolveContainedPath,
} from './storage.security';

/**
 * Local / Mock Storage Provider for development and automated tests.
 *
 * Implements private object semantics:
 * - Stores objects in memory and on local disk under `config.storage.localDir`
 * - Validates keys to prevent path traversal
 * - Generates mock expiring signed URLs (no permanent public URLs)
 */
@Injectable()
export class StorageMockProvider implements StorageProvider {
  readonly name = 'storage';
  readonly mode = ProviderMode.MOCK;

  private readonly logger = new Logger(StorageMockProvider.name);
  private readonly memoryStore = new Map<string, { body: Buffer; contentType: string }>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly behavior: MockBehavior,
  ) {}

  private assertCanonicalContainment(root: string, target: string, operation: string): void {
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ProviderError('storage', operation, 'invalid_key', 'Object key escapes the storage root', false);
    }
  }

  private async writableStoragePath(key: string): Promise<string> {
    const lexicalTarget = resolveContainedPath(this.config.storage.localDir, key, 'put');
    const lexicalRoot = path.resolve(this.config.storage.localDir);
    await fs.mkdir(lexicalRoot, { recursive: true });
    const canonicalRoot = await fs.realpath(lexicalRoot);
    const relativeParent = path.relative(lexicalRoot, path.dirname(lexicalTarget));
    let canonicalParent = canonicalRoot;

    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      const candidate = path.join(canonicalParent, segment);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) {
          throw new ProviderError('storage', 'put', 'invalid_key', 'Storage path contains a symbolic link', false);
        }
        if (!stat.isDirectory()) {
          throw new ProviderError('storage', 'put', 'invalid_key', 'Storage path component is not a directory', false);
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.mkdir(candidate);
      }
      canonicalParent = await fs.realpath(candidate);
      this.assertCanonicalContainment(canonicalRoot, canonicalParent, 'put');
    }

    return path.join(canonicalParent, path.basename(lexicalTarget));
  }

  private async readableStoragePath(key: string, operation: string): Promise<string> {
    const lexicalTarget = resolveContainedPath(this.config.storage.localDir, key, operation);
    const canonicalRoot = await fs.realpath(path.resolve(this.config.storage.localDir));
    const canonicalTarget = await fs.realpath(lexicalTarget);
    this.assertCanonicalContainment(canonicalRoot, canonicalTarget, operation);
    return canonicalTarget;
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    await this.behavior.begin('storage', 'put');

    if (!input.key) {
      throw new ProviderError('storage', 'put', 'invalid_key', 'Object key is required', false);
    }
    assertTenantObjectKey(input.tenantId, input.key, 'put');
    if (input.body.length > this.config.storage.maxObjectBytes) {
      throw new ProviderError('storage', 'put', 'object_too_large', 'Object exceeds configured size limit', false);
    }

    try {
      const filePath = await this.writableStoragePath(input.key);
      await fs.writeFile(filePath, input.body);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      this.logger.warn(`Failed to write local disk file for ${input.key}, stored in memory: ${(err as Error).message}`);
    }

    this.memoryStore.set(input.key, {
      body: input.body,
      contentType: input.contentType,
    });

    return {
      key: input.key,
      uri: `file://${this.config.storage.localDir}/${input.key}`,
      sizeBytes: input.body.length,
    };
  }

  async get(tenantId: string, key: string): Promise<StoredObject | null> {
    await this.behavior.begin('storage', 'get');
    assertTenantObjectKey(tenantId, key, 'get');

    const inMemory = this.memoryStore.get(key);
    if (inMemory) {
      return inMemory;
    }

    try {
      const filePath = await this.readableStoragePath(key, 'get');
      const body = await fs.readFile(filePath);
      return { body, contentType: 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async signedUrl(tenantId: string, key: string, expiresInSeconds: number): Promise<string> {
    await this.behavior.begin('storage', 'signedUrl');
    assertTenantObjectKey(tenantId, key, 'signedUrl');
    const expiry = boundedSignedUrlExpiry(expiresInSeconds, this.config.storage.signedUrlMaxExpirySeconds);
    const expiresAt = Date.now() + expiry * 1000;
    const base = this.config.api.publicBaseUrl.replace(/\/+$/, '');
    const signature = this.sign(key, expiresAt);
    const query = new URLSearchParams({ key, expires: String(expiresAt), sig: signature });
    return `${base}/${this.config.api.globalPrefix}/mock-storage?${query.toString()}`;
  }

  /** Resolve a development signed URL without weakening tenant-key validation. */
  async readSignedObject(key: string, expires: string, signature: string): Promise<StoredObject | null> {
    const expiresAt = Number(expires);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) {
      throw new ProviderError('storage', 'signedRead', 'expired_signature', 'Signed object URL has expired', false);
    }
    const expected = this.sign(key, expiresAt);
    const suppliedBytes = Buffer.from(signature || '', 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    if (suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
      throw new ProviderError('storage', 'signedRead', 'invalid_signature', 'Signed object URL is invalid', false);
    }

    const segments = key.split('/');
    const tenantId = segments[0] === 'tenants' || segments[0] === 'recordings' ? segments[1] : undefined;
    if (!tenantId) {
      throw new ProviderError('storage', 'signedRead', 'invalid_key', 'Signed object key has no tenant namespace', false);
    }
    return this.get(tenantId, key);
  }

  async exists(tenantId: string, key: string): Promise<boolean> {
    await this.behavior.begin('storage', 'exists');
    assertTenantObjectKey(tenantId, key, 'exists');
    if (this.memoryStore.has(key)) return true;
    try {
      const filePath = await this.readableStoragePath(key, 'exists');
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private sign(key: string, expiresAt: number): string {
    return crypto
      .createHmac('sha256', this.config.auth.jwtSecret)
      .update(`mock-storage\n${expiresAt}\n${key}`)
      .digest('hex');
  }
}
