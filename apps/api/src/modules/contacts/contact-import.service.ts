import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BulkImportContactsRequest, ContactImportDto } from '@aiking/shared';
import type { Contact, ContactImport, Prisma } from '@prisma/client';

import { NotFoundException } from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient, isUniqueViolation } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { STORAGE_PROVIDER, type StorageProvider } from '../../providers/provider.types';
import { tenantObjectKey } from '../../providers/storage/storage.security';
import { QueueService } from '../queue/queue.service';
import type { ContactImportJob, JobContext } from '../queue/queue.types';
import { CONTACT_IMPORT_BATCH_SIZE, parseContactCsv, type ParsedContactCsvRow } from './contact-csv';
import { normalizePhone } from './contacts.service';

const KNOWN_COLUMNS = new Set([
  'fullname', 'name', 'contactname', 'customername', 'phone', 'mobile', 'phonenumber', 'mobilenumber',
  'email', 'emailaddress', 'tags', 'whatsappoptedin', 'emailoptedin', 'tenantid',
]);
const MAX_REPORTED_ERRORS = 200;

class RowValidationError extends Error {}
class RowAlreadyCommitted extends Error {}

@Injectable()
export class ContactImportService {
  private readonly logger = new Logger(ContactImportService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly queue: QueueService,
    private readonly tenantContext: TenantContext,
  ) {}

  async submit(request: BulkImportContactsRequest): Promise<ContactImportDto> {
    const csv = request.csv ?? '';
    const parsed = parseContactCsv(csv);
    const tenantId = this.tenantContext.requireTenantId('contacts.import.submit');
    const importId = randomUUID();
    const objectKey = tenantObjectKey(tenantId, 'imports', `${importId}.csv`);

    await this.storage.put({
      tenantId,
      key: objectKey,
      body: Buffer.from(csv, 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      cacheControl: 'private, no-store',
    });
    const record = await this.prisma.contactImport.create({
      data: {
        id: importId,
        tenantId,
        objectKey,
        totalRows: parsed.rows.length,
        unknownColumnsAsCustomFields: request.unknownColumnsAsCustomFields ?? true,
      },
    });

    try {
      await this.queue.enqueue('contact-import', { tenantId, importId }, { jobId: importId, attempts: 5 });
    } catch (error) {
      await this.prisma.contactImport.update({
        where: { id: importId },
        data: { status: 'failed', errorSummary: `Queue submission failed: ${(error as Error).message}`, completedAt: new Date() },
      });
      throw error;
    }
    return toImportDto(record);
  }

  async get(importId: string): Promise<ContactImportDto> {
    const record = await this.prisma.contactImport.findUnique({ where: { id: importId } });
    if (!record) throw new NotFoundException('Contact import', importId);
    return toImportDto(record);
  }

  async process(job: ContactImportJob, context: JobContext): Promise<void> {
    await this.tenantContext.runAsWorker(job.tenantId, 'process contact CSV import', async () => {
      const record = await this.prisma.contactImport.findUnique({ where: { id: job.importId } });
      if (!record) throw new Error(`Contact import ${job.importId} no longer exists`);
      if (record.status === 'completed') return;

      try {
        await this.prisma.contactImport.update({
          where: { id: job.importId },
          data: { status: 'processing', startedAt: record.startedAt ?? new Date(), errorSummary: null },
        });
        const source = await this.storage.get(job.tenantId, record.objectKey);
        if (!source) throw new Error('Stored CSV source is missing');
        const parsed = parseContactCsv(source.body.toString('utf8'));
        const seen = buildSeenIdentities(parsed.rows.slice(0, record.processedRows));

        for (let offset = record.processedRows; offset < parsed.rows.length; offset += CONTACT_IMPORT_BATCH_SIZE) {
          const batch = parsed.rows.slice(offset, offset + CONTACT_IMPORT_BATCH_SIZE);
          const candidates = await this.preloadContacts(batch);
          for (const [batchIndex, row] of batch.entries()) {
            await this.processRow(
              job.importId,
              offset + batchIndex,
              row,
              record.unknownColumnsAsCustomFields,
              seen,
              candidates,
            );
          }
        }

        await this.prisma.contactImport.update({
          where: { id: job.importId },
          data: { status: 'completed', completedAt: new Date(), errorSummary: null },
        });
        this.logger.log(`contact import ${job.importId} completed`);
      } catch (error) {
        await this.prisma.contactImport.update({
          where: { id: job.importId },
          data: {
            status: context.isFinalAttempt ? 'failed' : 'queued',
            errorSummary: (error as Error).message,
            ...(context.isFinalAttempt ? { completedAt: new Date() } : {}),
          },
        });
        throw error;
      }
    }, job.actorUserId);
  }

  private async processRow(
    importId: string,
    expectedProcessedRows: number,
    row: ParsedContactCsvRow,
    asCustomFields: boolean,
    seen: Set<string>,
    candidates: Contact[],
  ): Promise<void> {
    try {
      const rawIdentities = identityKeys(
        normalizePhone(row.values.phone ?? row.values.mobile ?? row.values.phonenumber ?? row.values.mobilenumber),
        (row.values.email ?? row.values.emailaddress ?? '').trim().toLowerCase() || null,
      );
      if (rawIdentities.some((identity) => seen.has(identity))) throw new RowValidationError('duplicate identity in CSV');
      // Reserve the first occurrence even when that row is invalid. This keeps
      // duplicate classification deterministic after a worker resumes.
      rawIdentities.forEach((identity) => seen.add(identity));
      const input = validateRow(row, asCustomFields);
      const matches = candidates.filter((contact) =>
        (input.phone && contact.phone === input.phone) || (input.email && contact.email === input.email),
      );
      if (new Set(matches.map((contact) => contact.id)).size > 1) {
        throw new RowValidationError('phone and email belong to different contacts');
      }
      const existing = matches[0];

      await this.prisma.$transaction(async (tx) => {
        if (existing) await updateExisting(tx, existing, input);
        else await tx.contact.create({
          data: {
            tenantId: this.tenantContext.requireTenantId('contacts.import.row'),
            fullName: input.fullName,
            phone: input.phone,
            email: input.email,
            customFields: input.customFields,
            tags: input.tags,
            whatsappOptedIn: input.whatsappOptedIn,
            emailOptedIn: input.emailOptedIn,
          },
        });

        const checkpoint = await tx.contactImport.updateMany({
          where: { id: importId, processedRows: expectedProcessedRows },
          data: {
            processedRows: { increment: 1 },
            successCount: { increment: 1 },
            ...(existing ? { updatedCount: { increment: 1 } } : { createdCount: { increment: 1 } }),
          },
        });
        if (checkpoint.count !== 1) throw new RowAlreadyCommitted();
      });
    } catch (error) {
      if (error instanceof RowAlreadyCommitted) {
        return;
      }
      if (!(error instanceof RowValidationError) && !isUniqueViolation(error)) throw error;
      const current = await this.prisma.contactImport.findUnique({ where: { id: importId }, select: { errors: true } });
      const errors = Array.isArray(current?.errors) ? current.errors : [];
      await this.prisma.contactImport.updateMany({
        where: { id: importId, processedRows: expectedProcessedRows },
        data: {
          processedRows: { increment: 1 },
          failureCount: { increment: 1 },
          errors: [...errors.slice(0, MAX_REPORTED_ERRORS - 1), { row: row.line, message: (error as Error).message }] as Prisma.InputJsonValue,
        },
      });
    }
  }

  private async preloadContacts(rows: ParsedContactCsvRow[]): Promise<Contact[]> {
    const phones = new Set<string>();
    const emails = new Set<string>();
    for (const row of rows) {
      const phone = normalizePhone(row.values.phone ?? row.values.mobile ?? row.values.phonenumber ?? row.values.mobilenumber);
      const email = (row.values.email ?? row.values.emailaddress ?? '').trim().toLowerCase();
      if (phone) phones.add(phone);
      if (email) emails.add(email);
    }
    const or: Prisma.ContactWhereInput[] = [];
    if (phones.size) or.push({ phone: { in: [...phones] } });
    if (emails.size) or.push({ email: { in: [...emails] } });
    return or.length ? this.prisma.contact.findMany({ where: { OR: or } }) : [];
  }
}

interface NormalizedRow {
  fullName: string;
  phone: string | null;
  email: string | null;
  customFields: Prisma.InputJsonValue;
  tags: string[];
  whatsappOptedIn: boolean;
  emailOptedIn: boolean;
  hasWhatsapp: boolean;
  hasEmail: boolean;
}

function validateRow(row: ParsedContactCsvRow, asCustomFields: boolean): NormalizedRow {
  if (row.error) throw new RowValidationError(row.error);
  const value = row.values;
  if (value.tenantid) throw new RowValidationError('tenantId columns are not allowed');
  const fullName = value.fullname ?? value.name ?? value.contactname ?? value.customername ?? '';
  const phone = normalizePhone(value.phone ?? value.mobile ?? value.phonenumber ?? value.mobilenumber);
  const email = (value.email ?? value.emailaddress ?? '').trim().toLowerCase() || null;
  if (!fullName.trim()) throw new RowValidationError('fullName is required');
  if (!phone && !email) throw new RowValidationError('a phone number or email address is required');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RowValidationError('email address is invalid');
  const customFields: Record<string, string> = {};
  if (asCustomFields) for (const [key, item] of Object.entries(value)) if (!KNOWN_COLUMNS.has(key) && item) customFields[key] = item;
  const hasWhatsapp = Boolean(value.whatsappoptedin);
  const hasEmail = Boolean(value.emailoptedin);
  return {
    fullName: fullName.trim(), phone, email, customFields: customFields as Prisma.InputJsonValue,
    tags: (value.tags ?? '').split(/[;|]/).map((tag) => tag.trim()).filter(Boolean),
    whatsappOptedIn: hasWhatsapp ? parseBoolean(value.whatsappoptedin!) : false,
    emailOptedIn: hasEmail ? parseBoolean(value.emailoptedin!) : true,
    hasWhatsapp, hasEmail,
  };
}

async function updateExisting(tx: any, existing: Contact, input: NormalizedRow): Promise<void> {
  await tx.contact.update({
    where: { id: existing.id },
    data: {
      fullName: input.fullName,
      phone: input.phone ?? existing.phone,
      email: input.email ?? existing.email,
      customFields: { ...(existing.customFields as Record<string, unknown>), ...(input.customFields as object) },
      tags: Array.from(new Set([...existing.tags, ...input.tags])),
      deletedAt: null,
      ...(input.hasWhatsapp ? { whatsappOptedIn: input.whatsappOptedIn } : {}),
      ...(input.hasEmail ? { emailOptedIn: input.emailOptedIn } : {}),
    },
  });
}

function parseBoolean(value: string): boolean {
  return ['true', 'yes', 'y', '1', 'opted_in', 'opted-in'].includes(value.trim().toLowerCase());
}

function identityKeys(phone: string | null, email: string | null): string[] {
  return [...(phone ? [`p:${phone}`] : []), ...(email ? [`e:${email}`] : [])];
}

function buildSeenIdentities(rows: ParsedContactCsvRow[]): Set<string> {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.error) continue;
    identityKeys(
      normalizePhone(row.values.phone ?? row.values.mobile ?? row.values.phonenumber ?? row.values.mobilenumber),
      (row.values.email ?? row.values.emailaddress ?? '').trim().toLowerCase() || null,
    ).forEach((identity) => seen.add(identity));
  }
  return seen;
}

export function toImportDto(record: ContactImport): ContactImportDto {
  return {
    id: record.id,
    status: record.status as ContactImportDto['status'],
    totalRows: record.totalRows,
    processedRows: record.processedRows,
    successCount: record.successCount,
    createdCount: record.createdCount,
    updatedCount: record.updatedCount,
    failureCount: record.failureCount,
    errors: (Array.isArray(record.errors) ? record.errors : []) as Array<{ row: number; message: string }>,
    errorSummary: record.errorSummary,
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
  };
}
