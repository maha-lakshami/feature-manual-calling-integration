import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AppConfig } from '../../config/configuration';
import { MockBehavior } from '../mock-support';
import { StorageMockProvider } from './storage.mock';
import { resolveContainedPath } from './storage.security';

describe('StorageMockProvider security', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';
  let localDir: string;
  let provider: StorageMockProvider;

  beforeEach(async () => {
    localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiking-storage-'));
    const config = {
      providers: { mock: { seed: 'test-seed', failureRate: 0, latencyMs: 0 } },
      storage: { localDir, signedUrlMaxExpirySeconds: 300, maxObjectBytes: 1024 },
      api: { publicBaseUrl: 'http://localhost:3001', globalPrefix: 'api' },
      auth: { jwtSecret: 'test-storage-signing-secret' },
    } as unknown as AppConfig;
    provider = new StorageMockProvider(config, new MockBehavior(config));
  });

  afterEach(async () => {
    await fs.rm(localDir, { recursive: true, force: true });
  });

  it('stores and retrieves a normal nested tenant object', async () => {
    const key = `tenants/${tenantA}/recordings/nested/call.mp3`;
    const body = Buffer.from('mock-audio-bytes');
    const result = await provider.put({ tenantId: tenantA, key, body, contentType: 'audio/mpeg' });

    expect(result).toMatchObject({ key, sizeBytes: body.length });
    expect(await provider.exists(tenantA, key)).toBe(true);
    expect((await provider.get(tenantA, key))?.body.toString()).toBe('mock-audio-bytes');
  });

  it.each([
    `tenants/${tenantA}/../../secret.txt`,
    `tenants\\${tenantA}\\..\\..\\secret.txt`,
    `tenants/${tenantA}/%2e%2e%2fsecret.txt`,
  ])('rejects traversal key %s', async (key) => {
    await expect(provider.put({ tenantId: tenantA, key, body: Buffer.from('x'), contentType: 'text/plain' })).rejects.toMatchObject({
      providerCode: 'invalid_key',
    });
  });

  it('rejects a sibling-prefix escape during canonical path resolution', () => {
    expect(() => resolveContainedPath(path.join(localDir, 'data'), '../data-evil/file.txt', 'put')).toThrow(
      'Object key traversal is not allowed',
    );
  });

  it.each(['/tmp/secret.txt', 'C:\\Windows\\secret.txt'])('rejects absolute key %s', async (key) => {
    await expect(provider.get(tenantA, key)).rejects.toMatchObject({ providerCode: 'invalid_key' });
  });

  it('does not allow Tenant A to access Tenant B namespace', async () => {
    const key = `tenants/${tenantB}/recordings/call.mp3`;
    await expect(provider.signedUrl(tenantA, key, 300)).rejects.toMatchObject({ providerCode: 'invalid_key' });
  });

  it('bounds mock signed URL expiry and preserves the expected tenant key', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const key = `tenants/${tenantA}/recordings/call one.mp3`;
    const url = new URL(await provider.signedUrl(tenantA, key, 86_400));
    expect(Number(url.searchParams.get('expires'))).toBe(now + 300_000);
    expect(url.searchParams.get('key')).toBe(key);
    expect(url.searchParams.get('sig')).toMatch(/^[a-f0-9]{64}$/);
    jest.restoreAllMocks();
  });

  it('serves a stored object only while its signed URL is valid', async () => {
    const key = `tenants/${tenantA}/recordings/call.mp3`;
    await provider.put({ tenantId: tenantA, key, body: Buffer.from('audio'), contentType: 'audio/mpeg' });
    const url = new URL(await provider.signedUrl(tenantA, key, 60));

    await expect(
      provider.readSignedObject(
        url.searchParams.get('key')!,
        url.searchParams.get('expires')!,
        url.searchParams.get('sig')!,
      ),
    ).resolves.toMatchObject({ body: Buffer.from('audio'), contentType: 'audio/mpeg' });
    await expect(
      provider.readSignedObject(key, url.searchParams.get('expires')!, '0'.repeat(64)),
    ).rejects.toMatchObject({ providerCode: 'invalid_signature' });
  });

  it('rejects an expired signed URL', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const key = `tenants/${tenantA}/recordings/expired.mp3`;
    const url = new URL(await provider.signedUrl(tenantA, key, 1));
    jest.spyOn(Date, 'now').mockReturnValue(now + 1_001);

    await expect(
      provider.readSignedObject(
        url.searchParams.get('key')!,
        url.searchParams.get('expires')!,
        url.searchParams.get('sig')!,
      ),
    ).rejects.toMatchObject({ providerCode: 'expired_signature' });
    jest.restoreAllMocks();
  });

  it('handles a Unicode object name without leaving the tenant root', async () => {
    const key = `tenants/${tenantA}/imports/ग्राहक सूची.csv`;
    await provider.put({ tenantId: tenantA, key, body: Buffer.from('name'), contentType: 'text/csv' });
    expect(await provider.exists(tenantA, key)).toBe(true);
  });

  it('rejects objects above the configured size limit', async () => {
    const key = `tenants/${tenantA}/imports/too-large.csv`;
    await expect(
      provider.put({ tenantId: tenantA, key, body: Buffer.alloc(1025), contentType: 'text/csv' }),
    ).rejects.toMatchObject({ providerCode: 'object_too_large' });
  });
});
