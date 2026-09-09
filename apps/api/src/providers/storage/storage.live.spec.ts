import type { AppConfig } from '../../config/configuration';
import { StorageLiveProvider } from './storage.live';

describe('StorageLiveProvider security and SigV4', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';
  const secret = 'super-secret-signing-key';
  let provider: StorageLiveProvider;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const config = {
      storage: {
        bucket: 'private-bucket',
        region: 'ap-south-1',
        endpoint: 'https://objects.example.test',
        forcePathStyle: true,
        accessKeyId: 'test-access-key',
        secretAccessKey: secret,
        signedUrlMaxExpirySeconds: 300,
        maxObjectBytes: 1024,
      },
    } as unknown as AppConfig;
    provider = new StorageLiveProvider(config);
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: jest.fn().mockResolvedValue(''),
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('bounds expiry and signs the exact tenant object key', async () => {
    const key = `tenants/${tenantA}/recordings/call.mp3`;
    const url = new URL(await provider.signedUrl(tenantA, key, 86_400));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(decodeURIComponent(url.pathname)).toBe(`/private-bucket/${key}`);
  });

  it('encodes reserved and Unicode key bytes according to SigV4 URI rules', async () => {
    const key = `tenants/${tenantA}/exports/a + 100% # (ग्राहक).csv`;
    const url = await provider.signedUrl(tenantA, key, 60);
    expect(new URL(url).pathname).toContain(
      'a%20%2B%20100%25%20%23%20%28%E0%A4%97%E0%A5%8D%E0%A4%B0%E0%A4%BE%E0%A4%B9%E0%A4%95%29.csv',
    );
  });

  it('preserves nested paths and repeated slashes in the signed canonical URI', async () => {
    const key = `tenants/${tenantA}/exports/nested//artifact.txt`;
    expect(new URL(await provider.signedUrl(tenantA, key, 60)).pathname).toBe(`/private-bucket/${key}`);
  });

  it('refuses to sign another tenant namespace', async () => {
    const key = `tenants/${tenantB}/recordings/call.mp3`;
    await expect(provider.signedUrl(tenantA, key, 60)).rejects.toMatchObject({ providerCode: 'invalid_key' });
  });

  it('uploads private, non-cacheable objects without a public ACL', async () => {
    const key = `tenants/${tenantA}/recordings/call.mp3`;
    await provider.put({ tenantId: tenantA, key, body: Buffer.from('audio'), contentType: 'audio/mpeg' });

    const [, request] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(request.headers['cache-control']).toBe('private, no-store');
    expect(request.headers['x-amz-acl']).toBeUndefined();
    expect(request.headers['authorization']).toBeDefined();
  });

  it('never includes the secret credential or provider response body in an error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: jest.fn().mockResolvedValue(`echoed ${secret}`),
    });
    const key = `tenants/${tenantA}/recordings/call.mp3`;

    let message = '';
    try {
      await provider.put({ tenantId: tenantA, key, body: Buffer.from('audio'), contentType: 'audio/mpeg' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('S3 PUT failed with HTTP 500');
    expect(message).not.toContain(secret);
  });

  it('does not expose the secret key in a signed URL', async () => {
    const key = `tenants/${tenantA}/recordings/call.mp3`;
    expect(await provider.signedUrl(tenantA, key, 60)).not.toContain(secret);
  });
});
