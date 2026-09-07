import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createTenantIsolationExtension } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { QueueService } from '../queue/queue.service';
import { ContactImportService } from './contact-import.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const JOB_CONTEXT = { queue: 'contact-import', jobId: 'job', attempt: 1, maxAttempts: 5, isFinalAttempt: false } as any;

function harness() {
  const tenantContext = new TenantContext();
  const imports = new Map<string, any>();
  const contacts: any[] = [];
  const objects = new Map<string, Buffer>();
  let failCreateOnceAt: number | null = null;
  let createAttempts = 0;

  const contactImport = {
    create: jest.fn(async ({ data }: any) => {
      const now = new Date();
      const row = {
        status: 'queued', totalRows: 0, processedRows: 0, successCount: 0, createdCount: 0,
        updatedCount: 0, failureCount: 0, errors: [], errorSummary: null, startedAt: null,
        completedAt: null, createdAt: now, updatedAt: now, unknownColumnsAsCustomFields: true, ...data,
      };
      imports.set(row.id, row);
      return { ...row };
    }),
    findUnique: jest.fn(async ({ where }: any) => {
      const row = imports.get(where.id);
      return row && row.tenantId === tenantContext.requireTenantId('fake import read') ? row : null;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = imports.get(where.id);
      if (!row || row.tenantId !== tenantContext.requireTenantId('fake import update')) throw new Error('not found');
      for (const [key, value] of Object.entries(data)) {
        (row as any)[key] = value && typeof value === 'object' && 'increment' in value
          ? (row[key] ?? 0) + (value as any).increment
          : value;
      }
      row.updatedAt = new Date();
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const row = imports.get(where.id);
      if (!row || row.tenantId !== tenantContext.requireTenantId('fake import checkpoint') ||
          (where.processedRows !== undefined && row.processedRows !== where.processedRows)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        row[key] = value && typeof value === 'object' && 'increment' in value
          ? (row[key] ?? 0) + (value as any).increment
          : value;
      }
      return { count: 1 };
    }),
  };

  const contact = {
    findMany: jest.fn(async ({ where }: any) => {
      const tenantId = tenantContext.requireTenantId('fake contact read');
      return contacts.filter((item) => item.tenantId === tenantId && where.OR.some((part: any) =>
        (part.phone?.in ? part.phone.in.includes(item.phone) : part.phone === item.phone) ||
        (part.email?.in ? part.email.in.includes(item.email) : part.email === item.email),
      )).slice(0, 2);
    }),
    create: jest.fn(async ({ data }: any) => {
      createAttempts += 1;
      if (failCreateOnceAt === createAttempts) {
        failCreateOnceAt = null;
        throw new Error('transient database failure');
      }
      const now = new Date();
      const row = { id: `contact-${contacts.length + 1}`, optedOutAt: null, deletedAt: null, createdAt: now, updatedAt: now, ...data };
      contacts.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = contacts.find((item) => item.id === where.id);
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
  };
  const prisma: any = { contactImport, contact, $transaction: async (callback: any) => callback({ contactImport, contact }) };
  const storage: any = {
    put: jest.fn(async ({ tenantId, key, body }: any) => { objects.set(`${tenantId}:${key}`, body); return { key, uri: `mock://${key}`, sizeBytes: body.length }; }),
    get: jest.fn(async (tenantId: string, key: string) => {
      const body = objects.get(`${tenantId}:${key}`);
      return body ? { body, contentType: 'text/csv' } : null;
    }),
  };
  const queue: any = { enqueue: jest.fn(async () => 'job') };
  const service = new ContactImportService(prisma, storage, queue, tenantContext);
  const run = <T>(tenantId: string, callback: () => T) => tenantContext.runWithTenant({
    tenantId, userId: 'user', role: 'manager' as any, isSuperAdmin: false, viaSupport: false, viaWorker: false,
  }, callback);
  const submitAndProcess = async (csv: string) => {
    const accepted = await run(TENANT_A, () => service.submit({ csv }));
    await service.process({ tenantId: TENANT_A, importId: accepted.id }, JOB_CONTEXT);
    return run(TENANT_A, () => service.get(accepted.id));
  };
  return {
    service, run, submitAndProcess, imports, contacts, storage, queue, prisma, tenantContext,
    setFailAt: (n: number) => { failCreateOnceAt = n; },
  };
}

describe('background contact imports', () => {
  it('returns a durable job id before contact processing', async () => {
    const h = harness();
    const accepted = await h.run(TENANT_A, () => h.service.submit({ csv: 'fullName,email\nAlice,a@example.com' }));
    expect(accepted.status).toBe('queued');
    expect(h.contacts).toHaveLength(0);
    expect(h.queue.enqueue).toHaveBeenCalledWith('contact-import', expect.anything(), expect.objectContaining({ jobId: accepted.id }));
  });

  it.each([500, 1000])('processes %i synthetic contacts in the local worker', async (count) => {
    const h = harness();
    const queue = new QueueService({ queue: { driver: 'inline' } } as any);
    const service = new ContactImportService(h.prisma, h.storage, queue, h.tenantContext);
    queue.register('contact-import', (payload, context) => service.process(payload, context));
    const csv = `fullName,email\n${Array.from({ length: count }, (_, i) => `Contact ${i},c${i}@example.com`).join('\n')}`;
    const startedAt = Date.now();
    const accepted = await h.run(TENANT_A, () => service.submit({ csv }));
    await queue.drain(20_000);
    const result = await h.run(TENANT_A, () => service.get(accepted.id));
    expect(result).toMatchObject({ status: 'completed', processedRows: count, successCount: count, failureCount: 0 });
    expect(h.contacts).toHaveLength(count);
    expect(await queue.pendingCount()).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    await queue.onModuleDestroy();
  }, 20_000);

  it('continues after a malformed row', async () => {
    const h = harness();
    const result = await h.submitAndProcess('fullName,email\nAlice,a@example.com,extra\nBob,b@example.com');
    expect(result).toMatchObject({ status: 'completed', successCount: 1, failureCount: 1 });
  });

  it('does not duplicate repeated identities within a file', async () => {
    const h = harness();
    const result = await h.submitAndProcess('fullName,email\nAlice,a@example.com\nAlice Again,A@example.com');
    expect(h.contacts).toHaveLength(1);
    expect(result.failureCount).toBe(1);
  });

  it('updates an existing contact rather than duplicating it', async () => {
    const h = harness();
    h.contacts.push({ id: 'existing', tenantId: TENANT_A, fullName: 'Old', phone: null, email: 'a@example.com', customFields: {}, tags: [], deletedAt: null });
    const result = await h.submitAndProcess('fullName,email\nAlice,A@example.com');
    expect(h.contacts).toHaveLength(1);
    expect(result.updatedCount).toBe(1);
  });

  it('reactivates an archived contact', async () => {
    const h = harness();
    h.contacts.push({ id: 'archived', tenantId: TENANT_A, fullName: 'Old', phone: '+919876543210', email: null, customFields: {}, tags: [], deletedAt: new Date() });
    await h.submitAndProcess('fullName,phone\nRestored,9876543210');
    expect(h.contacts[0].deletedAt).toBeNull();
  });

  it('rejects conflicting archived phone and email identities', async () => {
    const h = harness();
    h.contacts.push(
      { id: 'one', tenantId: TENANT_A, phone: '+919876543210', email: null, customFields: {}, tags: [], deletedAt: new Date() },
      { id: 'two', tenantId: TENANT_A, phone: null, email: 'a@example.com', customFields: {}, tags: [], deletedAt: new Date() },
    );
    const result = await h.submitAndProcess('fullName,phone,email\nAlice,9876543210,a@example.com');
    expect(result.failureCount).toBe(1);
    expect(h.contacts.every((contact) => contact.deletedAt)).toBe(true);
  });

  it('rejects a CSV tenant override and never writes tenant B', async () => {
    const h = harness();
    const result = await h.submitAndProcess(`fullName,email,tenantId\nMallory,m@example.com,${TENANT_B}`);
    expect(result.failureCount).toBe(1);
    expect(h.contacts).toHaveLength(0);
  });

  it('resumes after a transient failure without duplicating committed rows', async () => {
    const h = harness();
    const accepted = await h.run(TENANT_A, () => h.service.submit({ csv: 'fullName,email\nAlice,a@example.com\nBob,b@example.com' }));
    h.setFailAt(2);
    await expect(h.service.process({ tenantId: TENANT_A, importId: accepted.id }, JOB_CONTEXT)).rejects.toThrow('transient');
    expect(h.imports.get(accepted.id).processedRows).toBe(1);
    await h.service.process({ tenantId: TENANT_A, importId: accepted.id }, { ...JOB_CONTEXT, attempt: 2 });
    expect(h.contacts).toHaveLength(2);
    expect(h.imports.get(accepted.id)).toMatchObject({ status: 'completed', successCount: 2 });
  });

  it('keeps import status reads tenant-scoped', async () => {
    const context = new TenantContext();
    const extension = createTenantIsolationExtension(context).query.$allModels.$allOperations;
    const query = jest.fn().mockResolvedValue(null);
    await context.runWithTenant({ tenantId: TENANT_A, userId: 'u', role: 'manager' as any, isSuperAdmin: false, viaSupport: false, viaWorker: false }, () =>
      extension({ model: 'ContactImport', operation: 'findUnique', args: { where: { id: 'foreign-id' } }, query }),
    );
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_A }) }));
  });
});

describe('scoped frontend API contracts', () => {
  const source = (file: string) => readFileSync(resolve(__dirname, `../../../../web/src/${file}`), 'utf8');

  it('uses page.total for the dashboard contact count', () => {
    expect(source('pages/DashboardPage.tsx')).toContain('page.total || 0');
    expect(source('pages/DashboardPage.tsx')).not.toContain('totalItems');
  });

  it('uses call detail transcript without requesting a turns route', () => {
    expect(source('pages/CallsPage.tsx')).toContain('api.calls.get(call.id)');
    expect(source('api/client.ts')).not.toContain('/turns`');
  });

  it('uses an environment-aware docs URL without localhost', () => {
    expect(source('components/layout/AppShell.tsx')).toContain('href={API_DOCS_URL}');
    expect(source('components/layout/AppShell.tsx')).not.toContain('localhost:3001');
  });
});
