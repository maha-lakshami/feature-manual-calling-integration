import { TenantContext } from '../../common/tenant/tenant-context';
import { assertTenantObjectKey } from '../../providers/storage/storage.security';
import { CallProcessors } from './call.processors';
import { CallsService } from './calls.service';

describe('recording storage isolation', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function processors(maxObjectBytes: number): CallProcessors {
    return new CallProcessors(
      {} as any,
      { storage: { maxObjectBytes } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { rateCallSafely: jest.fn() } as any,
      new TenantContext(),
    );
  }

  it('cannot sign a recording key belonging to another tenant', async () => {
    const prisma = {
      call: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'call-a',
          tenantId: tenantA,
          recordingKey: `tenants/${tenantB}/recordings/call-b.mp3`,
        }),
      },
    };
    const storage = {
      signedUrl: jest.fn().mockImplementation(async (tenantId: string, key: string) => {
        assertTenantObjectKey(tenantId, key, 'signedUrl');
        return 'https://objects.example.test/signed';
      }),
    };
    const service = new CallsService(
      prisma as any,
      {} as any,
      {} as any,
      storage as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new TenantContext(),
    );

    await expect(service.recordingUrl('call-a', 'operator@example.test')).rejects.toMatchObject({
      providerCode: 'invalid_key',
    });
    expect(storage.signedUrl).toHaveBeenCalledWith(
      tenantA,
      `tenants/${tenantB}/recordings/call-b.mp3`,
      300,
    );
  });

  it('rejects a recording whose declared size exceeds the object limit', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(Buffer.from('audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '1025' },
      }),
    );

    await expect((processors(1024) as any).fetchAudio('https://recording.example.test/call.mp3', 10)).rejects.toMatchObject({
      providerCode: 'recording_too_large',
    });
  });

  it('stops streaming a recording when actual bytes exceed the object limit', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(Buffer.from('12345'), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    );

    await expect((processors(4) as any).fetchAudio('https://recording.example.test/call.mp3', 10)).rejects.toMatchObject({
      providerCode: 'recording_too_large',
    });
  });

  it('rejects a non-audio recording response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('<html>not audio</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    await expect((processors(1024) as any).fetchAudio('https://recording.example.test/call.mp3', 10)).rejects.toMatchObject({
      providerCode: 'invalid_content_type',
    });
  });
});
