import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CallDirection,
  CallOutcome,
  CallStatus,
  Channel,
  CommunicationEventType,
  TranscriptSpeaker,
  UsageEventType,
  money,
  type CallDto,
  type Paginated,
  type PlaceCallRequest,
  type TranscriptTurnDto,
} from '@aiking/shared';
import type { Call, CallTranscriptTurn, Prisma } from '@prisma/client';

import { NotFoundException, ValidationFailedException } from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  STORAGE_PROVIDER,
  TELEPHONY_PROVIDER,
  type StorageProvider,
  type TelephonyProvider,
} from '../../providers/provider.types';
import { MeteringService } from '../billing/metering.service';
import { CommunicationsService } from '../communications/communications.service';
import { QueueService } from '../queue/queue.service';
import { ContactsService } from '../contacts/contacts.service';
import { WalletService } from '../wallet/wallet.service';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export const ESTIMATED_CALL_MINUTES = 3;

const RECORDING_URL_TTL_SECONDS = 300;

const DEFAULT_OBJECTIVE = 'delivery_confirmation';

export interface ListCallsQuery {
  page?: number;
  pageSize?: number;
  status?: CallStatus;
  outcome?: CallOutcome;
  contactId?: string;
}

export interface CallEventInput {
  providerCallId: string;
  event: 'ringing' | 'answered' | 'completed' | 'failed' | 'no_answer' | 'busy';
  durationSeconds?: number;
  billDurationSeconds?: number;
  recordingUrl?: string;
  hangupCause?: string;
}

export interface RecordingReadyInput {
  providerCallId: string;
  recordingUrl: string;
  durationSeconds: number;
}

const TERMINAL_STATUSES: readonly CallStatus[] = [
  CallStatus.COMPLETED,
  CallStatus.NO_ANSWER,
  CallStatus.BUSY,
  CallStatus.FAILED,
  CallStatus.ESCALATED,
];

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly queue: QueueService,
    private readonly metering: MeteringService,
    private readonly wallet: WalletService,
    private readonly contacts: ContactsService,
    private readonly communications: CommunicationsService,
    private readonly tenantContext: TenantContext,
  ) {}

  // ── Request path ───────────────────────────────────────────────────────────

  async list(query: ListCallsQuery = {}): Promise<Paginated<CallDto>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.CallWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.contactId ? { contactId: query.contactId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.call.findMany({
        where,
        include: { contact: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.call.count({ where }),
    ]);

    return {
      items: rows.map((row) => toCallDto(row, row.contact.fullName, [])),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  async get(callId: string): Promise<CallDto> {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: {
        contact: { select: { fullName: true } },
        transcriptTurns: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!call) throw new NotFoundException('Call', callId);
    return toCallDto(call, call.contact.fullName, call.transcriptTurns);
  }

  async place(request: PlaceCallRequest, createdBy: string): Promise<CallDto> {
    const tenantId = this.tenantContext.requireTenantId('calls.place');
    const contact = await this.contacts.get(request.contactId);
    const isManual = request.callType === 'manual';
    let bridgeNumber: string | null = null;

    if (!contact.phone) {
      throw new ValidationFailedException(`Contact ${contact.fullName} has no phone number to call`, {
        contactId: contact.id,
      });
    }

    if (contact.optedOutAt) {
      throw new ValidationFailedException(`Contact ${contact.fullName} has opted out of all communication`, {
        contactId: contact.id,
        optedOutAt: contact.optedOutAt,
      });
    }

    const estimatePaise = await this.metering.estimate(
      UsageEventType.AI_CALL_MINUTE,
      ESTIMATED_CALL_MINUTES,
      tenantId,
    );
    await this.wallet.assertAffordable(estimatePaise, `place an AI call to ${contact.fullName}`, tenantId);

    let dialToNumber = contact.phone;
    if (isManual) {
      if (!this.config.plivo.salespersonNumber) {
        throw new ValidationFailedException('No salesperson phone number is configured for manual calls');
      }
      bridgeNumber = contact.phone;
      dialToNumber = this.config.plivo.salespersonNumber;
    }

    const call = await this.prisma.call.create({
      data: {
        tenantId,
        contactId: contact.id,
        direction: CallDirection.OUTBOUND,
        status: CallStatus.QUEUED,
        fromNumber: this.config.plivo.fromNumber,
        toNumber: dialToNumber,
        bridgeNumber,
        callType: isManual ? 'manual' : 'ai',
        provider: this.telephony.providerId,
        objective: request.objective ?? DEFAULT_OBJECTIVE,
        scriptId: request.scriptId ?? null,
        createdBy,
        metadata: (request.metadata ?? {}) as Prisma.InputJsonValue,
      },
      include: { contact: { select: { fullName: true } } },
    });

    await this.queue.enqueue(
      'call-place',
      { tenantId, actorUserId: createdBy, callId: call.id },
      { jobId: `call:${call.id}` },
    );

    this.logger.log(`call ${call.id} queued to ${maskNumber(call.toNumber)} for contact ${contact.id}`);
    return toCallDto(call, call.contact.fullName, []);
  }

  async updateAnalysis(
    callId: string,
    input: {
      summary?: string;
      nextAction?: string;
      priority?: string;
      sentiment?: string;
      salesOutcome?: string;
      requirement?: string;
      objection?: string;
      followUpRequired?: boolean;
      followUpDate?: string;
      followUpTime?: string;
    },
  ): Promise<CallDto> {
    const call = await this.require(callId);

    const existingMetadata =
      call.metadata && typeof call.metadata === 'object' ? (call.metadata as Record<string, unknown>) : {};
    const updatedMetadata = {
      ...existingMetadata,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.sentiment !== undefined ? { sentiment: input.sentiment } : {}),
      ...(input.salesOutcome !== undefined ? { salesOutcome: input.salesOutcome } : {}),
      ...(input.requirement !== undefined ? { requirement: input.requirement } : {}),
      ...(input.objection !== undefined ? { objection: input.objection } : {}),
      ...(input.followUpRequired !== undefined ? { followUpRequired: input.followUpRequired } : {}),
      ...(input.followUpDate !== undefined ? { followUpDate: input.followUpDate } : {}),
      ...(input.followUpTime !== undefined ? { followUpTime: input.followUpTime } : {}),
    };

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: {
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
        metadata: updatedMetadata as Prisma.InputJsonValue,
      },
      include: {
        contact: { select: { fullName: true } },
        transcriptTurns: { orderBy: { sequence: 'asc' } },
      },
    });

    return toCallDto(updated, updated.contact.fullName, updated.transcriptTurns);
  }

  async escalate(callId: string, reason: string): Promise<CallDto> {
    const call = await this.require(callId);

    if (call.providerCallId && !TERMINAL_STATUSES.includes(call.status as CallStatus)) {
      await this.telephony.hangup(call.providerCallId).catch((error: unknown) => {
        this.logger.warn(`hangup during escalation of call ${callId} failed: ${(error as Error).message}`);
      });
    }

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: {
        status: CallStatus.ESCALATED,
        outcome: CallOutcome.ESCALATED_TO_HUMAN,
        escalatedAt: new Date(),
        escalationReason: reason,
        endedAt: call.endedAt ?? new Date(),
      },
      include: {
        contact: { select: { fullName: true } },
        transcriptTurns: { orderBy: { sequence: 'asc' } },
      },
    });

    await this.communications.recordSafely({
      tenantId: call.tenantId,
      contactId: call.contactId,
      callId: call.id,
      channel: Channel.CALL,
      eventType: CommunicationEventType.CALL_ESCALATED,
      summary: `Call escalated to a human: ${reason}`,
      providerReference: call.providerCallId,
      metadata: { reason },
    });

    return toCallDto(updated, updated.contact.fullName, updated.transcriptTurns);
  }

  async hangup(callId: string): Promise<CallDto> {
    const call = await this.require(callId);

    if (!call.providerCallId) {
      throw new ValidationFailedException('This call has not reached the provider yet', {
        callId,
        status: call.status,
      });
    }
    if (TERMINAL_STATUSES.includes(call.status as CallStatus)) {
      throw new ValidationFailedException(`Call is already ${call.status}`, { callId });
    }

    await this.telephony.hangup(call.providerCallId);
    this.logger.log(`call ${callId} hung up by request`);
    return this.get(callId);
  }

  async recordingUrl(callId: string, actor: string): Promise<{ url: string; expiresInSeconds: number }> {
    const call = await this.require(callId);

    if (!call.recordingKey) {
      throw new NotFoundException('Call recording', callId);
    }

    const url = await this.storage.signedUrl(call.tenantId, call.recordingKey, RECORDING_URL_TTL_SECONDS);

    this.logger.log(
      `recording access: call=${callId} key=${call.recordingKey} tenant=${call.tenantId} ` +
        `actor=${actor} ttl=${RECORDING_URL_TTL_SECONDS}s`,
    );

    return { url, expiresInSeconds: RECORDING_URL_TTL_SECONDS };
  }

  // ── Provider callbacks ─────────────────────────────────────────────────────

  async applyCallEvent(input: CallEventInput): Promise<void> {
    const located = await this.locate(input.providerCallId);
    if (!located) {
      this.logger.warn(`callback for unknown provider call ${input.providerCallId} — ignored`);
      return;
    }

    await this.tenantContext.runAsWorker(located.tenantId, `apply a ${input.event} call callback`, async () => {
      const call = await this.require(located.id);

      if (TERMINAL_STATUSES.includes(call.status as CallStatus) && input.event !== 'completed') {
        this.logger.debug(`late ${input.event} callback for ${call.status} call ${call.id} — ignored`);
        return;
      }

      switch (input.event) {
        case 'ringing':
          await this.prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.RINGING } });
          return;

        case 'answered':
          await this.prisma.call.update({
            where: { id: call.id },
            data: { status: CallStatus.IN_PROGRESS, startedAt: call.startedAt ?? new Date() },
          });
          return;

        case 'completed':
          await this.complete(call, input);
          return;

        case 'no_answer':
        case 'busy':
        case 'failed':
          await this.abandon(call, input);
          return;
      }
    });
  }

  async applyRecordingReady(input: RecordingReadyInput): Promise<void> {
    const located = await this.locate(input.providerCallId);
    if (!located) {
      this.logger.warn(`recording callback for unknown provider call ${input.providerCallId} — ignored`);
      return;
    }

    await this.tenantContext.runAsWorker(located.tenantId, 'ingest a call recording', async () => {
      const call = await this.require(located.id);

      if (call.recordingKey) {
        this.logger.debug(`call ${call.id} already has a stored recording — ignoring the replay`);
        return;
      }

      await this.queue.enqueue(
        'recording-ingest',
        {
          tenantId: located.tenantId,
          callId: call.id,
          recordingUrl: input.recordingUrl,
          durationSeconds: input.durationSeconds,
        },
        { jobId: `recording:${call.id}` },
      );
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async complete(call: Call, input: CallEventInput): Promise<void> {
    const durationSeconds = Math.max(0, Math.round(input.durationSeconds ?? 0));
    const minutes = this.metering.billableMinutes(durationSeconds);
    const key = reservationKey(call.id);

    let recordingUrl = input.recordingUrl;
    if (!recordingUrl && durationSeconds > 0 && call.providerCallId) {
      for (const delayMs of [8000, 12000, 15000]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          const recording = await this.telephony.fetchRecording(call.providerCallId);
          if (recording?.url) {
            recordingUrl = recording.url;
            break;
          }
          this.logger.warn(`No recording available yet for call ${call.id}, will retry`);
        } catch (error) {
          this.logger.warn(`Could not fetch recording for call ${call.id}: ${(error as Error).message}`);
        }
      }
    }

    let costPaise = 0n;

    if (minutes > 0) {
      const charge = await this.metering.settle({
        tenantId: call.tenantId,
        eventType: UsageEventType.AI_CALL_MINUTE,
        actualQuantity: minutes,
        idempotencyKey: key,
        description: `AI call to ${maskNumber(call.toNumber)} — ${minutes} min (${durationSeconds}s)`,
        contactId: call.contactId,
        callId: call.id,
        occurredAt: new Date(),
        metadata: { providerCallId: call.providerCallId, durationSeconds, hangupCause: input.hangupCause },
      });
      costPaise = charge.totalChargePaise;
    } else {
      await this.metering.release({
        tenantId: call.tenantId,
        idempotencyKey: key,
        reason: `Call ${call.id} connected but carried no billable audio`,
      });
    }

    const endedAt = new Date();

    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        status: recordingUrl ? CallStatus.SUMMARIZING : CallStatus.COMPLETED,
        durationSeconds,
        billedMinutes: minutes,
        costPaise,
        endedAt,
        startedAt: call.startedAt ?? new Date(endedAt.getTime() - durationSeconds * 1000),
        failureReason: null,
        ...(recordingUrl ? {} : { outcome: call.outcome ?? CallOutcome.UNKNOWN }),
      },
    });

    if (recordingUrl) {
      await this.queue.enqueue(
        'recording-ingest',
        { tenantId: call.tenantId, callId: call.id, recordingUrl, durationSeconds },
        { jobId: `recording:${call.id}` },
      );
    }

    await this.communications.recordSafely({
      tenantId: call.tenantId,
      contactId: call.contactId,
      callId: call.id,
      channel: Channel.CALL,
      eventType: CommunicationEventType.CALL_COMPLETED,
      summary: `AI call completed — ${formatDuration(durationSeconds)}, ${minutes} billed minute${minutes === 1 ? '' : 's'}`,
      providerReference: call.providerCallId,
      metadata: { durationSeconds, billedMinutes: minutes, hangupCause: input.hangupCause },
    });

    this.logger.log(`call ${call.id} completed: ${durationSeconds}s → ${minutes} min, ${costPaise} paise`);

    await this.queue
      .enqueue(
        'call-shadow-rate',
        {
          tenantId: call.tenantId,
          callId: call.id,
          billDurationSeconds: input.billDurationSeconds,
          legacyCostPaise: costPaise.toString(),
        },
        {
          jobId: `call-shadow-rate:${call.id}`,
          attempts: 3,
        },
      )
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to enqueue shadow rating job for call ${call.id} (tenant ${call.tenantId}): ${(error as Error).message}`,
        );
      });
  }

  private async abandon(call: Call, input: CallEventInput): Promise<void> {
    await this.metering.release({
      tenantId: call.tenantId,
      idempotencyKey: reservationKey(call.id),
      reason: `Call ${call.id} ended as ${input.event}`,
    });

    const status =
      input.event === 'no_answer'
        ? CallStatus.NO_ANSWER
        : input.event === 'busy'
          ? CallStatus.BUSY
          : CallStatus.FAILED;

    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        status,
        outcome: CallOutcome.UNREACHABLE,
        durationSeconds: 0,
        billedMinutes: 0,
        costPaise: 0n,
        endedAt: new Date(),
        failureReason: input.hangupCause ?? input.event,
      },
    });

    await this.communications.recordSafely({
      tenantId: call.tenantId,
      contactId: call.contactId,
      callId: call.id,
      channel: Channel.CALL,
      eventType: CommunicationEventType.CALL_FAILED,
      summary: `AI call not connected — ${input.event.replace(/_/g, ' ')}`,
      providerReference: call.providerCallId,
      metadata: { event: input.event, hangupCause: input.hangupCause },
    });

    this.logger.log(`call ${call.id} ended as ${input.event} — reservation released, nothing billed`);
  }

  private async locate(providerCallId: string): Promise<{ id: string; tenantId: string } | null> {
    return this.tenantContext.runAsSystem(`resolve provider call ${providerCallId}`, () =>
      this.prisma.call.findUnique({
        where: { providerCallId },
        select: { id: true, tenantId: true },
      }),
    );
  }

  private async require(callId: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call', callId);
    return call;
  }
}

export function reservationKey(callId: string): string {
  return `call:${callId}`;
}

export function toCallDto(call: Call, contactName: string, turns: CallTranscriptTurn[]): CallDto {
  const meta =
    call.metadata && typeof call.metadata === 'object'
      ? (call.metadata as Record<string, unknown>)
      : {};
  const priority =
    typeof meta.priority === 'string' && ['urgent', 'high', 'medium', 'low'].includes(meta.priority)
      ? (meta.priority as 'urgent' | 'high' | 'medium' | 'low')
      : call.escalatedAt
        ? 'urgent'
        : call.summary
          ? 'medium'
          : null;
  const sentiment =
    typeof meta.sentiment === 'string' && ['positive', 'neutral', 'negative'].includes(meta.sentiment)
      ? (meta.sentiment as 'positive' | 'neutral' | 'negative')
      : null;
  const salesOutcome =
    typeof meta.salesOutcome === 'string' &&
    ['interested', 'not_interested', 'callback_requested', 'converted'].includes(meta.salesOutcome)
      ? (meta.salesOutcome as 'interested' | 'not_interested' | 'callback_requested' | 'converted')
      : null;
  const requirement = typeof meta.requirement === 'string' ? meta.requirement : null;
  const objection = typeof meta.objection === 'string' ? meta.objection : null;
  const followUpRequired = typeof meta.followUpRequired === 'boolean' ? meta.followUpRequired : null;
  const followUpDate = typeof meta.followUpDate === 'string' ? meta.followUpDate : null;
  const followUpTime = typeof meta.followUpTime === 'string' ? meta.followUpTime : null;

  return {
    id: call.id,
    contactId: call.contactId,
    contactName,
    direction: call.direction as CallDirection,
    callType: call.callType as 'ai' | 'manual',
    bridgeNumber: call.bridgeNumber,
    status: call.status as CallStatus,
    outcome: (call.outcome as CallOutcome | null) ?? null,
    providerCallId: call.providerCallId,
    fromNumber: call.fromNumber,
    toNumber: call.toNumber,
    durationSeconds: call.durationSeconds,
    billedMinutes: call.billedMinutes,
    cost: call.costPaise === null ? null : money(call.costPaise),
    recordingKey: call.recordingKey,
    summary: call.summary,
    nextAction: call.nextAction,
    priority,
    sentiment,
    salesOutcome,
    requirement,
    objection,
    followUpRequired,
    followUpDate,
    followUpTime,
    transcript: turns.map(toTranscriptTurnDto),
    promptVersion: call.promptVersion,
    escalatedAt: call.escalatedAt?.toISOString() ?? null,
    startedAt: call.startedAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    createdAt: call.createdAt.toISOString(),
  };
}

export function toTranscriptTurnDto(turn: CallTranscriptTurn): TranscriptTurnDto {
  return {
    sequence: turn.sequence,
    speaker: turn.speaker as TranscriptSpeaker,
    text: turn.text,
    confidence: turn.confidence,
    atSeconds: turn.atSeconds,
  };
}

export function maskNumber(number: string): string {
  if (number.length <= 6) return number;
  return `${number.slice(0, 3)}${'*'.repeat(Math.max(0, number.length - 7))}${number.slice(-4)}`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}